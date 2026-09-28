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

const MAX_PDF_SIZE = 20 * 1024 * 1024;
const VALID_QUELLEN = new Set(['scanner', 'lieferant']);
const ABHOLEN_TTL_SECONDS = 15 * 60;

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_PDF_SIZE } });

// Eine Gutschrift trägt im Portal immer einen positiven Betrag, die Bedeutung liegt in `typ`.
// Für n8n kommt beides zusätzlich als signierter Wert, damit Rückerstattungen korrekt gebucht werden.
function typUndSigniert(job) {
  const typ = job.typ || 'rechnung';
  const betrag = Number(job.betrag);
  const betragSigniert = job.betrag == null || Number.isNaN(betrag) ? null : (typ === 'gutschrift' ? -betrag : betrag).toFixed(2);
  return { typ, betrag_signiert: betragSigniert };
}

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

  router.get('/abholbereit', async (req, res, next) => {
    try {
    const nurMitZeitstempel = Boolean(getConfigValue(db, 'zeitstempel_tsa_url'));
    const jobs = listAbholbereitJobs(db, undefined, nurMitZeitstempel);
    const einzelPayload = await Promise.all(
      jobs.map(async (job) => {
        const snapshot = job.freigabe_snapshot ? JSON.parse(job.freigabe_snapshot) : null;
        const konto = snapshot?.konto || null;
        const iban = snapshot?.zahlungsdaten?.iban ?? null;
        const kontoinhaber = snapshot?.zahlungsdaten?.kontoinhaber ?? null;
        return {
          nachweis_status: snapshot ? 'snapshot' : 'historisch_unvollstaendig',
          export_nachweis_url: `/api/n8n/jobs/${job.id}/exportnachweis`,
          id: job.id,
          eingang_am: job.eingang_am,
          quelle: job.quelle,
          absender: job.absender,
          lieferant: job.lieferant,
          rechnungsnummer: job.rechnungsnummer,
          betrag: job.betrag,
          ...typUndSigniert(job),
          zahlungsziel: job.zahlungsziel,
          dateiname: job.dateiname,
          konto_id: job.konto_id,
          konto_kontonummer: konto?.kontonummer ?? null,
          konto_bezeichnung: konto?.bezeichnung ?? null,
          eingereicht_von: job.eingereicht_von,
          auslage_datum: job.auslage_datum,
          beschreibung: job.beschreibung,
          // An unknown invoice date must not be substituted with the payment deadline.
          rechnungsdatum: job.rechnungsdatum || null,
          iban,
          kontoinhaber,
          qr_iban: job.qr_iban,
          qr_referenz: job.qr_referenz,
          qr_betrag: job.qr_betrag,
          qr_waehrung: job.qr_waehrung,
          qr_creditor_name: job.qr_creditor_name,
          qr_erkannt_am: job.qr_erkannt_am,
          download_url: buildSignedDownloadUrl(config, job.id, ABHOLEN_TTL_SECONDS),
        };
      })
    );

    const gruppen = listAbholbereitGruppen(db, undefined, nurMitZeitstempel);
    const gruppenPayload = gruppen.map((parent) => {
      // gruppe_pdf_pfad is only ever set once pruefeSplitGruppenVollstaendigkeit reported the
      // group complete, which already guarantees every non-geloescht sibling reached
      // 'abgeschlossen' (and therefore has a real konto_id, not just a hinweis_konto_id) -- so a
      // plain geloescht-filter is enough here, no separate konto_id check needed.
      const kinder = listSplitKinder(db, parent.id).filter((k) => k.status !== 'geloescht');
      const positionen = kinder.map((kind) => {
        const snapshot = kind.freigabe_snapshot ? JSON.parse(kind.freigabe_snapshot) : null;
        const konto = snapshot?.konto;
        return {
          konto_id: kind.konto_id,
          konto_kontonummer: konto?.kontonummer ?? null,
          konto_bezeichnung: konto?.bezeichnung ?? null,
          betrag: kind.betrag,
          ...typUndSigniert(kind),
          position: kind.rechnungsposition,
        };
      });
      return {
        id: parent.id,
        export_nachweis_url: `/api/n8n/jobs/${parent.id}/exportnachweis`,
        eingang_am: parent.eingang_am,
        quelle: parent.quelle,
        absender: parent.absender,
        lieferant: parent.lieferant,
        rechnungsnummer: parent.rechnungsnummer,
        betrag: parent.betrag,
        zahlungsziel: parent.zahlungsziel,
        dateiname: parent.dateiname,
        // QR-Bill-Daten stammen aus dem Intake und stehen unverändert auf dem Elternjob (das
        // Aufsplitten fasst sie nicht an) -- gleiche Feldnamen wie beim Einzeljob-Eintrag oben,
        // damit n8n für eine Splitgruppe genau dieselben Zahlungsdaten bekommt wie sonst auch.
        qr_iban: parent.qr_iban,
        qr_referenz: parent.qr_referenz,
        qr_betrag: parent.qr_betrag,
        qr_waehrung: parent.qr_waehrung,
        qr_creditor_name: parent.qr_creditor_name,
        qr_erkannt_am: parent.qr_erkannt_am,
        positionen,
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
