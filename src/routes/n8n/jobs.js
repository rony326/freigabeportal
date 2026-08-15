import { Router } from 'express';
import multer from 'multer';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createJob, getJobById } from '../../db/jobsRepo.js';

const MAX_PDF_SIZE = 20 * 1024 * 1024;
const VALID_QUELLEN = new Set(['scanner', 'lieferant']);

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
      const job = getJobById(db, id);
      res.status(201).json({ id: job.id, status: job.status });
    });
  });

  return router;
}
