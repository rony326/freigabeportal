import { Router } from 'express';
import multer from 'multer';
import { writeFileSync, mkdirSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createJob, getJobById, listAbholbereitJobs, confirmAbholung, setThumbnailPfad } from '../../db/jobsRepo.js';
import { getConfigValue } from '../../db/adminConfigRepo.js';
import { renderFirstPageThumbnail } from '../../services/thumbnail.js';
import { buildSignedDownloadUrl } from '../../services/downloadUrl.js';

const MAX_PDF_SIZE = 20 * 1024 * 1024;
const VALID_QUELLEN = new Set(['scanner', 'lieferant']);
const ABHOLEN_TTL_SECONDS = 15 * 60;

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_PDF_SIZE } });

function isPdf(buffer) {
  return buffer.length >= 4 && buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46;
}

export function createN8nJobsRouter({ db, config }) {
  const router = Router();

  router.post('/', (req, res) => {
    upload.single('pdf')(req, res, (uploadErr) => {
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

      const { quelle, absender, dateiname } = req.body;
      if (!VALID_QUELLEN.has(quelle)) {
        return res.status(400).json({ error: 'quelle muss "scanner" oder "lieferant" sein.' });
      }
      if (!dateiname) {
        return res.status(400).json({ error: 'dateiname ist ein Pflichtfeld.' });
      }

      const eingangAm = req.body.eingang_am || new Date().toISOString();

      mkdirSync(config.jobsDir, { recursive: true });
      const pdfPfad = join(config.jobsDir, `job-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);
      writeFileSync(pdfPfad, req.file.buffer);

      const id = createJob(db, { eingangAm, quelle, absender: absender || null, dateiname, pdfPfad });
      const visumSeitePosition = getConfigValue(db, 'visum_seite_position') || 'letzte';
      try {
        const thumbnailPng = renderFirstPageThumbnail(req.file.buffer, visumSeitePosition);
        const thumbnailPfad = pdfPfad.replace(/\.pdf$/, '.png');
        writeFileSync(thumbnailPfad, thumbnailPng);
        setThumbnailPfad(db, id, thumbnailPfad);
      } catch (err) {
        console.error(`Thumbnail-Rendering fehlgeschlagen für Job ${id}:`, err.message);
      }
      const job = getJobById(db, id);
      res.status(201).json({ id: job.id, status: job.status });
    });
  });

  router.get('/abholbereit', (req, res) => {
    const jobs = listAbholbereitJobs(db);
    const payload = jobs.map((job) => ({
      id: job.id,
      eingang_am: job.eingang_am,
      quelle: job.quelle,
      absender: job.absender,
      dateiname: job.dateiname,
      konto_id: job.konto_id,
      download_url: buildSignedDownloadUrl(config, job.id, ABHOLEN_TTL_SECONDS),
    }));
    res.json(payload);
  });

  router.post('/:id/abholung-bestaetigen', (req, res) => {
    const job = confirmAbholung(db, Number(req.params.id));
    if (!job) {
      return res.status(409).json({ error: 'Job ist nicht im Status "abgeschlossen" oder bereits abgeholt.' });
    }
    if (job.pdf_pfad && existsSync(job.pdf_pfad)) {
      unlinkSync(job.pdf_pfad);
    }
    res.json({ id: job.id, status: job.status });
  });

  return router;
}
