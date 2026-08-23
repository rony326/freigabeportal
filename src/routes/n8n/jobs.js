import { Router } from 'express';
import multer from 'multer';
import { writeFileSync, mkdirSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import crypto from 'node:crypto';
import { createJob, getJobById, findJobByDateiHash, listAbholbereitJobs, confirmAbholung, setThumbnailPfad, setQrDaten } from '../../db/jobsRepo.js';
import { renderFirstPageThumbnail } from '../../services/thumbnail.js';
import { scanQrBill } from '../../services/qrBillScan.js';
import { buildSignedDownloadUrl } from '../../services/downloadUrl.js';
import { getPersonById } from '../../db/personenRepo.js';
import { sendNotification } from '../../services/notify.js';
import { getConfigValue } from '../../db/adminConfigRepo.js';

const MAX_PDF_SIZE = 20 * 1024 * 1024;
const VALID_QUELLEN = new Set(['scanner', 'lieferant']);
const ABHOLEN_TTL_SECONDS = 15 * 60;

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_PDF_SIZE } });

function isPdf(buffer) {
  return buffer.length >= 4 && buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46;
}

export function createN8nJobsRouter({ db, config, mailer }) {
  const router = Router();

  router.post('/', (req, res, next) => {
    upload.single('pdf')(req, res, async (uploadErr) => {
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
        const job = getJobById(db, id);

        if (job.status === 'zugewiesen') {
          const freigeber1 = getPersonById(db, job.zugewiesen_an);
          if (freigeber1) {
            await sendNotification(db, mailer, {
              to: freigeber1.email,
              subject: 'Freigabeportal: Neue Rechnung zur Kontierung',
              text: `Eine neue Rechnung wurde dir automatisch zugewiesen: ${job.dateiname}\n\nBitte im Freigabeportal anmelden: ${config.publicBaseUrl}/kontierung/${job.id}`,
              typ: 'zuweisung',
              jobId: job.id,
            });
          }
        }

        res.status(201).json({ id: job.id, status: job.status });
      } catch (err) {
        next(err);
      }
    });
  });

  router.get('/abholbereit', (req, res) => {
    const nurMitZeitstempel = Boolean(getConfigValue(db, 'zeitstempel_tsa_url'));
    const jobs = listAbholbereitJobs(db, undefined, nurMitZeitstempel);
    const payload = jobs.map((job) => ({
      id: job.id,
      eingang_am: job.eingang_am,
      quelle: job.quelle,
      absender: job.absender,
      lieferant: job.lieferant,
      rechnungsnummer: job.rechnungsnummer,
      betrag: job.betrag,
      zahlungsziel: job.zahlungsziel,
      dateiname: job.dateiname,
      konto_id: job.konto_id,
      download_url: buildSignedDownloadUrl(config, job.id, ABHOLEN_TTL_SECONDS),
    }));
    res.json(payload);
  });

  router.post('/:id/abholung-bestaetigen', (req, res) => {
    const nurMitZeitstempel = Boolean(getConfigValue(db, 'zeitstempel_tsa_url'));
    const job = confirmAbholung(db, Number(req.params.id), nurMitZeitstempel);
    if (!job) {
      return res
        .status(409)
        .json({ error: 'Job ist nicht im Status "abgeschlossen" oder bereits abgeholt, oder der Zeitstempel steht noch aus.' });
    }
    try {
      if (job.pdf_pfad && existsSync(job.pdf_pfad)) {
        unlinkSync(job.pdf_pfad);
      }
    } catch (err) {
      console.error(`Löschen der PDF für Job ${job.id} nach Abholung fehlgeschlagen:`, err.message);
    }
    try {
      if (job.thumbnail_pfad && existsSync(job.thumbnail_pfad)) {
        unlinkSync(job.thumbnail_pfad);
      }
    } catch (err) {
      console.error(`Löschen des Thumbnails für Job ${job.id} nach Abholung fehlgeschlagen:`, err.message);
    }
    res.json({ id: job.id, status: job.status });
  });

  return router;
}
