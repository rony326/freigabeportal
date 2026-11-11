// Zeitstempel prüfen (`/zeitstempel-pruefen`, docs/zeitstempel-und-pruefbescheinigung.md): Prüfseite zu einem Vorgang (`?jobId=`) oder zu einer hochgeladenen PDF, plus druckbare Prüfbescheinigung
// (`/zertifikat`). Sichtrecht wie beim PDF-Zugriff (services/jobAuthorization.js). Zugang: angemeldet.

import { Router } from 'express';
import multer from 'multer';
import { mitAuditKontext } from '../services/auditContext.js';
import { readFileSync, existsSync } from 'node:fs';
import { getJobById } from '../db/jobsRepo.js';
import { canViewJobPdf } from '../services/jobAuthorization.js';
import { verifyZeitstempel } from '../services/zeitstempel.js';
import { jobDocument } from '../services/jobDocument.js';
import { kommentarBereich } from './kommentare.js';
import { asyncCallback, asyncHandler } from '../middleware/asyncHandler.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

export function createZeitstempelPruefenRouter({ db, config, csrfProtection = (req, res, next) => next() }) {
  const router = Router();

  // GET /zeitstempel-pruefen[?jobId=] – ohne jobId das Upload-Formular, mit jobId die Prüfung des gespeicherten PDFs (samt Kommentarbereich).
  router.get('/', asyncHandler(async (req, res, next) => {
    try {
      const jobId = req.query.jobId ? Number(req.query.jobId) : null;
      if (!jobId) {
        return res.render('zeitstempel-pruefen', { ergebnis: null, errors: [], jobId: null, job: null });
      }
      const job = jobDocument(getJobById(db, jobId));
      if (!job || !canViewJobPdf(db, config, req.currentPerson, job)) {
        return res.status(403).render('error', { message: 'Kein Zugriff auf diesen Job.' });
      }
      // Kommentarbereich auch für abgeschlossene Vorgänge (dann nur lesend) und Mail-Links mit
      // #kommentare für Beteiligte ohne Arbeitsseite (z. B. die Spesen-Einreicherin).
      const kommentare = kommentarBereich(db, config, req.currentPerson, job, `/zeitstempel-pruefen?jobId=${job.id}`);
      if (!job.pdf_pfad || !existsSync(job.pdf_pfad)) {
        // n8n löscht das lokale PDF, sobald ein Vorgang abgeholt ist — aber zeitstempel_datei_hash bleibt in der DB in jedem Fall erhalten, die Prüfung ist also weiterhin über das einfache
        // Upload-Formular möglich (Hash-Vergleich mit diesem gespeicherten Wert). Ein blosses 404 war hier eine Sackgasse für alle, deren Vorgang schon abgeholt war; die vorbelegte jobId erspart das Suchen.
        return res.render('zeitstempel-pruefen', {
          ergebnis: null,
          errors: [],
          jobId,
          job: null,
          hinweis:
            'Die Originaldatei liegt im Portal nicht mehr vor (bereits abgeholt/archiviert). Lade die archivierte Kopie hoch, um sie zu prüfen — die Job-ID ist bereits eingetragen.',
          kommentarBereich: kommentare,
        });
      }
      const ergebnis = await verifyZeitstempel(readFileSync(job.pdf_pfad), job.zeitstempel_datei_hash);
      res.render('zeitstempel-pruefen', { ergebnis, errors: [], jobId, job, kommentarBereich: kommentare });
    } catch (err) {
      next(err);
    }
  }));

  // GET /zeitstempel-pruefen/zertifikat?jobId= – druckbare Prüfbescheinigung zum gespeicherten PDF.
  router.get('/zertifikat', asyncHandler(async (req, res, next) => {
    try {
      const jobId = Number(req.query.jobId);
      const job = jobId ? jobDocument(getJobById(db, jobId)) : null;
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
  }));

  // POST /zeitstempel-pruefen – Prüfung einer hochgeladenen PDF (höchstens 25 MB), optional mit Hash-Vergleich gegen einen Vorgang (`jobId`) und dann als Prüfbescheinigung.
  router.post('/', (req, res, next) => {
    mitAuditKontext(upload.single('pdf'))(req, res, asyncCallback(next, async (uploadErr) => {
      // csrfProtection muss nach multer laufen, nicht davor: multer parst den multipart-Body (inklusive des Textfelds _csrf) — liefe csrfProtection früher, wäre req.body leer und jede Einreichung würde abgelehnt.
      csrfProtection(req, res, asyncCallback(next, async (csrfErr) => {
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
          vergleichsJob = jobDocument(getJobById(db, Number(req.body.jobId)));
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
      }));
    }));
  });

  return router;
}
