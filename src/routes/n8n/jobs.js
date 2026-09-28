import { Router, json } from 'express';
import multer from 'multer';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import crypto from 'node:crypto';
import { createJob, getJobById, findJobByDateiHash, listAbholbereitJobs, listAbholbereitGruppen, confirmAbholung, confirmGruppenAbholung, istGruppenElternjob, listSplitKinder, setThumbnailPfad, setQrDaten, setKkTextAnalyse } from '../../db/jobsRepo.js';
import { renderFirstPageThumbnail } from '../../services/thumbnail.js';
import { scanQrBill } from '../../services/qrBillScan.js';
import { buildSignedDownloadUrl } from '../../services/downloadUrl.js';
import { getPersonById } from '../../db/personenRepo.js';
import { sendNotificationMitVertretung } from '../../services/notify.js';
import { getConfigValue } from '../../db/adminConfigRepo.js';
import { extrahierePdfText } from '../../services/pdfText.js';
import { analysiereText } from '../../services/kkTextAnalyse.js';
import { erkenneKarte, hatErkennbareKarten } from '../../services/kkErkennung.js';
import { markiereAlsKkAbrechnung } from '../../services/kkMarkierung.js';
import { createExportEvidence, readExportDocument, confirmArchiveReceipt, ArchiveError } from '../../services/archiveReceipt.js';
import { machineAuditContext, mitAuditKontext } from '../../services/auditContext.js';
import { exportNachweis } from '../../services/exportSnapshot.js';

const MAX_PDF_SIZE = 20 * 1024 * 1024;
const VALID_QUELLEN = new Set(['scanner', 'lieferant']);
const ABHOLEN_TTL_SECONDS = 15 * 60;

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_PDF_SIZE } });

function isPdf(buffer) {
  return buffer.length >= 4 && buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46;
}

export function createN8nJobsRouter({ db, config, mailer }) {
  const router = Router();
  router.use(machineAuditContext('service:n8n', 'n8n'));
  router.param('id', (req, res, next, value) => {
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0) {
      return res.status(400).json({ error: 'Ungueltige Job-ID.' });
    }
    next();
  });

  router.post('/', (req, res, next) => {
    mitAuditKontext(upload.single('pdf'))(req, res, async (uploadErr) => {
      try {
        if (uploadErr) {
          const message = uploadErr.code === 'LIMIT_FILE_SIZE' ? 'Die PDF-Datei darf höchstens 20 MB gross sein.' : 'Fehler beim Datei-Upload.';
          return res.status(400).json({ error: message });
        }
        if (!req.file) {
          return res.status(400).json({ error: 'PDF-Datei (Feld "pdf") fehlt.' });
        }
        if (!isPdf(req.file.buffer)) {
          return res.status(400).json({ error: 'Datei ist keine gültige PDF-Datei.' });
        }

        // Catches the same PDF bytes being submitted twice (an n8n retry, or an IMAP trigger
        // firing more than once for the same message) — the byte-identical file always hashes
        // identically, while two genuinely different invoices never do. Returns the existing
        // job instead of creating a duplicate, so a retried submission is idempotent rather
        // than an error n8n would need to handle specially.
        const dateiHash = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
        const vorhandenerJob = findJobByDateiHash(db, dateiHash);
        if (vorhandenerJob) {
          return res.status(200).json({ id: vorhandenerJob.id, status: vorhandenerJob.status, duplikat: true });
        }

        const { quelle, absender, dateiname } = req.body;
        if (!VALID_QUELLEN.has(quelle)) {
          return res.status(400).json({ error: 'quelle muss "scanner" oder "lieferant" sein.' });
        }
        if (!dateiname) {
          return res.status(400).json({ error: 'dateiname ist ein Pflichtfeld.' });
        }

        let eingangAm;
        if (req.body.eingang_am) {
          const parsed = new Date(req.body.eingang_am);
          if (Number.isNaN(parsed.getTime())) {
            return res.status(400).json({ error: 'eingang_am ist kein gültiges Datum.' });
          }
          // Store the normalized ISO form, not the raw input — the reminder/escalation sweeps
          // compare eingang_am as a plain string against an ISO threshold, so a malformed-but-
          // parseable value (e.g. non-ISO format) stored raw could otherwise make a job
          // invisible to those comparisons forever.
          eingangAm = parsed.toISOString();
        } else {
          eingangAm = new Date().toISOString();
        }

        mkdirSync(config.jobsDir, { recursive: true });
        const pdfPfad = join(config.jobsDir, `job-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);
        writeFileSync(pdfPfad, req.file.buffer);

        const id = createJob(db, { eingangAm, quelle, absender: absender || null, dateiname, pdfPfad, dateiHash });
        try {
          const thumbnailPng = renderFirstPageThumbnail(req.file.buffer);
          const thumbnailPfad = pdfPfad.replace(/\.pdf$/, '.png');
          writeFileSync(thumbnailPfad, thumbnailPng);
          setThumbnailPfad(db, id, thumbnailPfad);
        } catch (err) {
          console.error(`Thumbnail-Rendering fehlgeschlagen für Job ${id}:`, err.message);
        }
        try {
          const qrDaten = scanQrBill(req.file.buffer);
          if (qrDaten) {
            setQrDaten(db, id, {
              qrIban: qrDaten.iban,
              qrReferenz: qrDaten.referenz,
              qrBetrag: qrDaten.betrag,
              qrWaehrung: qrDaten.waehrung,
              qrCreditorName: qrDaten.creditorName,
            });
          }
        } catch (err) {
          console.error(`QR-Code-Erkennung fehlgeschlagen für Job ${id}:`, err.message);
        }

        let kkMarkiert = false;
        if (getConfigValue(db, 'modul_kreditkarten_aktiv') === '1' && hatErkennbareKarten(db)) {
          try {
            const text = extrahierePdfText(req.file.buffer);
            const erkennung = erkenneKarte(db, { absender, text });
            if (erkennung) {
              setKkTextAnalyse(db, id, analysiereText(text));
              const aktuell = getJobById(db, id);
              kkMarkiert = await markiereAlsKkAbrechnung(db, config, mailer, {
                job: aktuell, karte: erkennung.karte, markiertVon: null, ip: 'system', ausStatus: aktuell.status, kommentarZusatz: ` — ${erkennung.grund}`,
              });
            }
          } catch (err) {
            console.error(`Kreditkarten-Erkennung fehlgeschlagen für Job ${id}:`, err.message);
          }
        }

        const job = getJobById(db, id);

        if (job.status === 'zugewiesen' && !kkMarkiert) {
          const freigeber1 = getPersonById(db, job.zugewiesen_an);
          if (freigeber1) {
            await sendNotificationMitVertretung(db, mailer, {
              person: freigeber1,
              typ: 'zuweisung',
              jobId: job.id,
              variablen: {
                jobDateiname: job.dateiname,
                grund: 'Eine neue Rechnung wurde dir automatisch zugewiesen.',
                link: `${config.publicBaseUrl}/kontierung/${job.id}`,
              },
            });
          }
        }

        res.status(201).json({ id: job.id, status: job.status });
      } catch (err) {
        next(err);
      }
    });
  });

  // Every business and payment field comes from the frozen export evidence (services/exportSnapshot.js),
  // never from the live job row. Legacy cases without sufficient evidence stay blocked here until an
  // Altfall decision exists; n8n may trigger a payment only when zahlung.freigegeben is true.
  router.get('/abholbereit', (req, res, next) => {
    try {
      const nurMitZeitstempel = Boolean(getConfigValue(db, 'zeitstempel_tsa_url'));
      const exportierbar = (job) => exportNachweis(db, job).exportierbar;
      const einzelPayload = listAbholbereitJobs(db, undefined, nurMitZeitstempel, exportierbar).map((job) => {
        const nachweis = exportNachweis(db, job);
        const m = nachweis.metadaten;
        const spesenZahlung = nachweis.zahlung.art === 'spesen' && nachweis.zahlung.freigegeben;
        return {
          nachweis_status: nachweis.status,
          export_nachweis_url: `/api/n8n/jobs/${job.id}/exportnachweis`,
          id: job.id,
          eingang_am: m.eingang_am,
          quelle: m.quelle,
          absender: m.absender,
          lieferant: m.lieferant,
          rechnungsnummer: m.rechnungsnummer,
          betrag: m.betrag,
          typ: m.typ,
          betrag_signiert: m.betrag_signiert,
          zahlungsziel: m.zahlungsziel,
          dateiname: m.dateiname,
          konto_id: m.konto_id,
          konto_kontonummer: m.konto_kontonummer,
          konto_bezeichnung: m.konto_bezeichnung,
          eingereicht_von: m.eingereicht_von,
          auslage_datum: m.auslage_datum,
          beschreibung: m.beschreibung,
          rechnungsdatum: m.rechnungsdatum,
          iban: spesenZahlung ? nachweis.zahlung.iban : null,
          kontoinhaber: spesenZahlung ? nachweis.zahlung.kontoinhaber : null,
          qr_iban: m.qr_iban,
          qr_referenz: m.qr_referenz,
          qr_betrag: m.qr_betrag,
          qr_waehrung: m.qr_waehrung,
          qr_creditor_name: m.qr_creditor_name,
          qr_erkannt_am: m.qr_erkannt_am,
          zahlung: nachweis.zahlung,
          ...(nachweis.altfall ? { altfall: nachweis.altfall } : {}),
          download_url: buildSignedDownloadUrl(config, job.id, ABHOLEN_TTL_SECONDS),
        };
      });

      const gruppenPayload = listAbholbereitGruppen(db, undefined, nurMitZeitstempel, exportierbar).map((parent) => {
        const nachweis = exportNachweis(db, parent);
        const m = nachweis.metadaten;
        return {
          id: parent.id,
          nachweis_status: nachweis.status,
          export_nachweis_url: `/api/n8n/jobs/${parent.id}/exportnachweis`,
          eingang_am: m.eingang_am,
          quelle: m.quelle,
          absender: m.absender,
          lieferant: m.lieferant,
          rechnungsnummer: m.rechnungsnummer,
          betrag: m.betrag,
          zahlungsziel: m.zahlungsziel,
          rechnungsdatum: m.rechnungsdatum,
          dateiname: m.dateiname,
          qr_iban: m.qr_iban,
          qr_referenz: m.qr_referenz,
          qr_betrag: m.qr_betrag,
          qr_waehrung: m.qr_waehrung,
          qr_creditor_name: m.qr_creditor_name,
          qr_erkannt_am: m.qr_erkannt_am,
          zahlung: nachweis.zahlung,
          ...(nachweis.altfall ? { altfall: nachweis.altfall } : {}),
          positionen: nachweis.positionen.map((position) => ({
            job_id: position.job_id,
            konto_id: position.konto_id,
            konto_kontonummer: position.konto_kontonummer,
            konto_bezeichnung: position.konto_bezeichnung,
            betrag: position.betrag,
            typ: position.typ,
            betrag_signiert: position.betrag_signiert,
            position: position.position,
          })),
          download_url: buildSignedDownloadUrl(config, parent.id, ABHOLEN_TTL_SECONDS),
        };
      });

      res.json([...einzelPayload, ...gruppenPayload]);
    } catch (err) {
      next(err);
    }
  });

  router.get('/archivierung-ausstehend', (req, res) => {
    const after = req.query.nach_id ?? '0';
    if (typeof after !== 'string' || !/^\d+$/.test(after) || !Number.isSafeInteger(Number(after))) {
      return res.status(400).json({ error: 'Ungueltiger Cursor nach_id.' });
    }
    const rows = db.prepare(`SELECT j.id, j.status FROM jobs j
      WHERE j.id > ? AND j.aufgesplittet_von IS NULL
        AND (j.status IN ('abgeholt', 'archiviert') OR (j.status = 'aufgesplittet' AND j.gruppe_abgeholt_am IS NOT NULL))
        AND NOT EXISTS (SELECT 1 FROM export_nachweise e JOIN archiv_quittungen q ON q.export_id = e.id WHERE e.job_id = j.id)
      ORDER BY j.id LIMIT 100`).all(Number(after));
    res.set('Cache-Control', 'no-store').json(rows.map((row) => ({ ...row, export_nachweis_url: `/api/n8n/jobs/${row.id}/exportnachweis` })));
  });

  router.get('/:id/exportnachweis', (req, res, next) => {
    try {
      res.set('Cache-Control', 'no-store').json(createExportEvidence(db, Number(req.params.id)));
    } catch (err) {
      if (err instanceof ArchiveError) return res.status(err.status).json({ error: err.message });
      next(err);
    }
  });

  router.post('/:id/archivierung-bestaetigen', json({ limit: '8kb' }), (req, res, next) => {
    try {
      const quittung = confirmArchiveReceipt(db, Number(req.params.id), req.body);
      res.json({ id: Number(req.params.id), status: 'archiv_bestaetigt', quittung });
    } catch (err) {
      if (err instanceof ArchiveError) return res.status(err.status).json({ error: err.message });
      next(err);
    }
  });

  router.get('/:id/exportdatei/:exportId', (req, res, next) => {
    try {
      const bytes = readExportDocument(db, Number(req.params.id), req.params.exportId);
      res.set('Cache-Control', 'no-store').type('application/pdf').send(bytes);
    } catch (err) {
      if (err instanceof ArchiveError) return res.status(err.status).json({ error: err.message });
      next(err);
    }
  });

  // Compatibility ACK records transport only. It never proves archival or deletes files.
  router.post('/:id/abholung-bestaetigen', (req, res, next) => {
    const nurMitZeitstempel = Boolean(getConfigValue(db, 'zeitstempel_tsa_url'));
    const id = Number(req.params.id);
    db.exec('BEGIN IMMEDIATE');
    try {
      const vorher = getJobById(db, id);
      if (vorher && !vorher.aufgesplittet_von && (vorher.status === 'abgeschlossen' || vorher.gruppe_pdf_pfad) && !exportNachweis(db, vorher).exportierbar) {
        db.exec('ROLLBACK');
        return res.status(409).json({ error: 'Beleg ist wegen fehlendem Freigabe-/Zahlungsnachweis zur Nachpruefung gesperrt.' });
      }
      if (istGruppenElternjob(db, id)) {
        const ergebnis = confirmGruppenAbholung(db, id, nurMitZeitstempel);
        if (!ergebnis) {
          db.exec('ROLLBACK');
          return res
            .status(409)
            .json({ error: 'Splitgruppe ist nicht bereit zur Abholung, oder der Zeitstempel steht noch aus.' });
        }
        db.exec('COMMIT');
        return res.json({ id: ergebnis.parent.id, status: 'abgeholt', archiv_bestaetigt: false });
      }

      const candidate = getJobById(db, id);
      const job = candidate?.aufgesplittet_von ? null : confirmAbholung(db, id, nurMitZeitstempel);
      if (!job) {
        db.exec('ROLLBACK');
        return res
          .status(409)
          .json({ error: 'Job ist nicht im Status "abgeschlossen" oder bereits abgeholt, oder der Zeitstempel steht noch aus.' });
      }
      db.exec('COMMIT');
      res.json({ id: job.id, status: job.status, archiv_bestaetigt: false });
    } catch (err) {
      db.exec('ROLLBACK');
      next(err);
    }
  });

  return router;
}
