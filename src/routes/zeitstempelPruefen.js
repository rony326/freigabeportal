import { Router } from 'express';
import multer from 'multer';
import { readFileSync, existsSync } from 'node:fs';
import { getJobById } from '../db/jobsRepo.js';
import { canViewJobPdf } from '../services/jobAuthorization.js';
import { verifyZeitstempel } from '../services/zeitstempel.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

export function createZeitstempelPruefenRouter({ db, config, csrfProtection = (req, res, next) => next() }) {
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
        // n8n deletes the local PDF once a job is abgeholt — but zeitstempel_datei_hash survives
        // in the DB regardless, so verification is still possible via the plain upload form
        // (hash-compared against that stored value). A bare 404 here was a dead end for anyone
        // whose job had already been picked up; pre-filling jobId spares them hunting it down.
        return res.render('zeitstempel-pruefen', {
          ergebnis: null,
          errors: [],
          jobId,
          job: null,
          hinweis:
            'Die Originaldatei liegt im Portal nicht mehr vor (bereits abgeholt/archiviert). Lade die archivierte Kopie hoch, um sie zu prüfen — die Job-ID ist bereits eingetragen.',
        });
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
      res.render('zeitstempel-zertifikat', { ergebnis, job, erstelltAm: new Date().toISOString(), erstelltVon: `${req.currentPerson.vorname} ${req.currentPerson.nachname}`, hochgeladen: false });
    } catch (err) {
      next(err);
    }
  });

  router.post('/', (req, res, next) => {
    upload.single('pdf')(req, res, async (uploadErr) => {
      // csrfProtection must run after multer, not before: multer is what parses the multipart
      // body (including the _csrf text field) — running csrfProtection any earlier would find
      // req.body empty and reject every submission.
      csrfProtection(req, res, async (csrfErr) => {
      if (csrfErr) return next(csrfErr);
      try {
        if (uploadErr) {
          const message = uploadErr.code === 'LIMIT_FILE_SIZE' ? 'Die Datei darf höchstens 25 MB gross sein.' : 'Fehler beim Datei-Upload.';
          return res.status(400).render('zeitstempel-pruefen', { ergebnis: null, errors: [message], jobId: null, job: null });
        }
        if (!req.file) {
          return res.status(400).render('zeitstempel-pruefen', { ergebnis: null, errors: ['Bitte eine PDF-Datei auswählen.'], jobId: null, job: null });
        }
        let vergleichsJob = null;
        if (req.body.jobId) {
          vergleichsJob = getJobById(db, Number(req.body.jobId));
          if (!vergleichsJob || !canViewJobPdf(db, config, req.currentPerson, vergleichsJob)) {
            return res.status(403).render('error', { message: 'Kein Zugriff auf diesen Job.' });
          }
        }
        const ergebnis = await verifyZeitstempel(req.file.buffer, vergleichsJob ? vergleichsJob.zeitstempel_datei_hash : null);
        if (vergleichsJob) {
          return res.render('zeitstempel-zertifikat', {
            ergebnis,
            job: vergleichsJob,
            erstelltAm: new Date().toISOString(),
            erstelltVon: `${req.currentPerson.vorname} ${req.currentPerson.nachname}`,
            hochgeladen: true,
          });
        }
        res.render('zeitstempel-pruefen', { ergebnis, errors: [], jobId: null, job: null });
      } catch (err) {
        next(err);
      }
      });
    });
  });

  return router;
}
