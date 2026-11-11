// PDF-Auslieferung und Vorschau (`/downloads/…`, docs/n8n-schnittstelle.md und docs/rechnungs-workflow.md): der PDF-Strom `GET /:jobId` läuft ohne Sitzung über eine
// signierte, kurzlebige Adresse (n8n und die Vorschau im <iframe>); `refresh-url`, `oeffnen` und `thumbnail` verlangen eine Sitzung und prüfen die Sichtberechtigung je Vorgang.

import { Router } from 'express';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { getJobById } from '../db/jobsRepo.js';
import { buildSignedDownloadUrl, verifySignedDownload, PDF_PREVIEW_TTL_SECONDS } from '../services/downloadUrl.js';
import { requireLogin } from '../middleware/roles.js';
import { canViewJobPdf } from '../services/jobAuthorization.js';

const GENERIC_DENIAL = { error: 'Link ungültig oder abgelaufen.' };

// sessionLimiter/publicLimiter werden hereingereicht, statt einmal an der Einbindung von /downloads in app.js angewendet zu werden: refresh-url und thumbnail
// verlangen beide eine Sitzung (requireLogin unten) und werden bei jedem Neuladen einmal je Dashboard-Zeile abgerufen, gehören also zur Sitzungsstufe (je Person gezählt,
// grosszügiges Budget) neben dem übrigen angemeldeten Teil der App. Der blosse PDF-Strom unter GET /:jobId ist das Gegenteil — unauthentifiziert, nur über eine
// kurzlebige signierte Adresse erreichbar — und bleibt auf der IP-gezählten öffentlichen Stufe. Vor dieser Trennung teilten sich alle drei ein IP-gezähltes Budget,
// ein Dashboard mit mehr als einer Handvoll Zeilen konnte es also schon nach wenigen Seitenaufrufen aufbrauchen.
const NOOP_LIMITER = (req, res, next) => next();

export function createDownloadsRouter({ db, config, sessionLimiter = NOOP_LIMITER, publicLimiter = NOOP_LIMITER }) {
  const router = Router();

  // GET /downloads/:jobId/refresh-url – für den Knopf "Neu laden" neben einer abgelaufenen PDF-Vorschau: prüft die aktuelle Sitzung erneut gegen den Vorgang (nicht die alte
  // Signatur) und stellt eine frische, kurzlebige signierte Adresse aus; ein Browser, der länger als PDF_PREVIEW_TTL_SECONDS untätig war, braucht so kein vollständiges Neuladen.
  router.get('/:jobId/refresh-url', sessionLimiter, requireLogin(), (req, res) => {
    const jobId = Number(req.params.jobId);
    const job = getJobById(db, jobId);
    if (!job) {
      return res.status(404).json({ error: 'Job nicht gefunden.' });
    }
    if (!canViewJobPdf(db, config, req.currentPerson, job)) {
      return res.status(403).json({ error: 'Kein Zugriff auf diesen Job.' });
    }
    res.json({ url: buildSignedDownloadUrl(config, jobId, PDF_PREVIEW_TTL_SECONDS) });
  });

  // GET /downloads/:jobId/oeffnen – "PDF öffnen" auf Handy/Tablet (views/_beleg_umschalter.ejs, Pool-Thumbnails): ein stabiler Link im Markup statt einer signierten Adresse, die
  // abläuft, solange die Seite offen ist. Gleiche erneute Prüfung wie refresh-url, danach eine Weiterleitung auf eine frisch signierte Adresse — funktioniert ohne JS und öffnet in einem
  // neuen Tab (target=_blank), ohne Popup-Blocker auszulösen.
  router.get('/:jobId/oeffnen', sessionLimiter, requireLogin(), (req, res) => {
    const jobId = Number(req.params.jobId);
    const job = getJobById(db, jobId);
    if (!job) {
      return res.status(404).json({ error: 'Job nicht gefunden.' });
    }
    if (!canViewJobPdf(db, config, req.currentPerson, job)) {
      return res.status(403).json({ error: 'Kein Zugriff auf diesen Job.' });
    }
    res.setHeader('Cache-Control', 'no-store');
    res.redirect(302, buildSignedDownloadUrl(config, jobId, PDF_PREVIEW_TTL_SECONDS));
  });

  // GET /downloads/:jobId/thumbnail – gleiche Berechtigung wie /:jobId/refresh-url: jede Sitzung, die das PDF dieses Vorgangs sehen darf, darf auch sein Thumbnail sehen (Dashboard-Tabelle,
  // inklusive Pool-Bereich). Per Sitzung authentifiziert, anders als der PDF-Strom unten (der eine signierte Adresse nutzt, damit n8n ihn ohne Sitzung abrufen kann).
  router.get('/:jobId/thumbnail', sessionLimiter, requireLogin(), (req, res) => {
    const jobId = Number(req.params.jobId);
    const job = getJobById(db, jobId);
    const authorized = job && canViewJobPdf(db, config, req.currentPerson, job);
    if (!authorized || !job.thumbnail_pfad || !existsSync(job.thumbnail_pfad)) {
      return res.status(404).json({ error: 'Kein Thumbnail vorhanden.' });
    }
    const stream = createReadStream(job.thumbnail_pfad);
    stream.on('error', () => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.status(404).type('json').json({ error: 'Kein Thumbnail vorhanden.' });
    });
    res.type('image/png');
    stream.pipe(res);
  });

  // GET /downloads/:jobId?expires=…&signature=… – streamt das PDF (bei einer Splitgruppe das zusammengeführte Gruppen-PDF, sofern noch vorhanden); jeder Fehler antwortet gleich (403), damit nichts verraten wird.
  router.get('/:jobId', publicLimiter, (req, res) => {
    const jobId = Number(req.params.jobId);
    const { expires, signature } = req.query;

    if (!verifySignedDownload(config, jobId, expires, signature)) {
      return res.status(403).json(GENERIC_DENIAL);
    }

    const job = getJobById(db, jobId);
    // gruppe_pdf_pfad bleibt auf dem Elternjob stehen, auch nachdem die Abholung durch n8n die
    // zusammengeführte Datei bereits gelöscht hat. Ohne die Existenzprüfung würde dieser Download
    // danach dauerhaft 403 liefern, obwohl die Original-Rechnung des Elternjobs (pdf_pfad)
    // laut Design nie gelöscht wird und weiterhin auf der Platte liegt.
    const gruppenPfadExistiert = job?.gruppe_pdf_pfad && existsSync(job.gruppe_pdf_pfad);
    const pfad = gruppenPfadExistiert ? job.gruppe_pdf_pfad : job?.pdf_pfad;
    if (!job || !existsSync(pfad)) {
      return res.status(403).json(GENERIC_DENIAL);
    }

    const stream = createReadStream(pfad);
    stream.on('error', () => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      // res.type() unten hat den Content-Type-Header für den Normalfall schon gesetzt; hier ausdrücklich zurücksetzen, damit diese Fehlerantwort wie jede andere Ablehnung ein
      // echtes application/json-403 ist und nicht application/pdf mit einem JSON-Body.
      res.status(403).type('json').json(GENERIC_DENIAL);
    });
    res.type('application/pdf');
    // Ohne ausdrückliches Content-Disposition fallen manche Browser (und Browser-/Betriebssystem-Richtlinien für PDFs) auf das Herunterladen zurück, statt die Datei in der von
    // pool.ejs, kontierung.ejs und freigabe2.ejs genutzten <iframe>-Vorschau darzustellen. "inline" plus ein bereinigter Dateiname (CR/LF entfernt, Anführungszeichen maskiert) lässt
    // jeden Browser sie an Ort und Stelle darstellen.
    // filename*= (RFC 5987) trägt Zeichen ausserhalb von ASCII (€, Umlaute aus UTF-8, Emoji);
    // Node lehnt sie im normalen filename="" ab (ERR_INVALID_CHAR → 500).
    const safeName = job.dateiname.replace(/[\r\n"]/g, '');
    const asciiName = safeName.replace(/[^\x20-\x7e]/gu, '_');
    const kodiert = encodeURIComponent(safeName).replace(/['()*]/g, (z) => `%${z.charCodeAt(0).toString(16).toUpperCase()}`);
    res.setHeader('Content-Disposition', `inline; filename="${asciiName}"${asciiName === safeName ? '' : `; filename*=UTF-8''${kodiert}`}`);
    // Eine Antwort in Stücken ohne Content-Length löst bei manchen PDF-Betrachtern (vor allem Safari/iOS) bekanntermassen eine Download-Abfrage statt der Darstellung an Ort und Stelle
    // aus — die ausdrückliche Angabe beseitigt diese Unklarheit für jeden Browser.
    res.setHeader('Content-Length', statSync(pfad).size);
    stream.pipe(res);
  });

  return router;
}
