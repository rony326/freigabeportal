import { Router } from 'express';
import multer from 'multer';
import { readFileSync, existsSync } from 'node:fs';
import { getJobById } from '../db/jobsRepo.js';
import { canViewJobPdf } from '../services/jobAuthorization.js';
import { verifyZeitstempel } from '../services/zeitstempel.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

export function createZeitstempelPruefenRouter({ db, config }) {
  const router = Router();

  router.get('/', async (req, res, next) => {
    try {
      const jobId = req.query.jobId ? Number(req.query.jobId) : null;
      if (!jobId) {
        return res.render('zeitstempel-pruefen', { ergebnis: null, errors: [], jobId: null, job: null });
      }
      const job = getJobById(db, jobId);
      if (!job || !canViewJobPdf(db, config, req.currentPerson, job)) {
        return res.status(403).render('error', { message: 'Kein Zugriff auf diesen Job.' });
      }
      if (!job.pdf_pfad || !existsSync(job.pdf_pfad)) {
        return res.status(404).render('error', { message: 'PDF-Datei für diesen Job ist nicht mehr vorhanden.' });
      }
      const ergebnis = await verifyZeitstempel(readFileSync(job.pdf_pfad), job.zeitstempel_datei_hash);
      res.render('zeitstempel-pruefen', { ergebnis, errors: [], jobId, job });
    } catch (err) {
      next(err);
    }
  });

  router.get('/zertifikat', async (req, res, next) => {
    try {
      const jobId = Number(req.query.jobId);
      const job = jobId ? getJobById(db, jobId) : null;
      if (!job || !canViewJobPdf(db, config, req.currentPerson, job)) {
        return res.status(403).render('error', { message: 'Kein Zugriff auf diesen Job.' });
      }
      if (!job.pdf_pfad || !existsSync(job.pdf_pfad)) {
        return res.status(404).render('error', { message: 'PDF-Datei für diesen Job ist nicht mehr vorhanden.' });
      }
      const ergebnis = await verifyZeitstempel(readFileSync(job.pdf_pfad), job.zeitstempel_datei_hash);
      res.render('zeitstempel-zertifikat', { ergebnis, job, erstelltAm: new Date().toISOString(), erstelltVon: `${req.currentPerson.vorname} ${req.currentPerson.nachname}` });
    } catch (err) {
      next(err);
    }
  });

  router.post('/', (req, res, next) => {
    upload.single('pdf')(req, res, async (uploadErr) => {
      try {
        if (uploadErr) {
          const message = uploadErr.code === 'LIMIT_FILE_SIZE' ? 'Die Datei darf höchstens 25 MB gross sein.' : 'Fehler beim Datei-Upload.';
          return res.status(400).render('zeitstempel-pruefen', { ergebnis: null, errors: [message], jobId: null, job: null });
        }
        if (!req.file) {
          return res.status(400).render('zeitstempel-pruefen', { ergebnis: null, errors: ['Bitte eine PDF-Datei auswählen.'], jobId: null, job: null });
        }
        const ergebnis = await verifyZeitstempel(req.file.buffer);
        res.render('zeitstempel-pruefen', { ergebnis, errors: [], jobId: null, job: null });
      } catch (err) {
        next(err);
      }
    });
  });

  return router;
}
