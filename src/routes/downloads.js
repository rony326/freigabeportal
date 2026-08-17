import { Router } from 'express';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { getJobById } from '../db/jobsRepo.js';
import { buildSignedDownloadUrl, verifySignedDownload, PDF_PREVIEW_TTL_SECONDS } from '../services/downloadUrl.js';
import { requireLogin } from '../middleware/roles.js';
import { canViewJobPdf } from '../services/jobAuthorization.js';

const GENERIC_DENIAL = { error: 'Link ungültig oder abgelaufen.' };

export function createDownloadsRouter({ db, config }) {
  const router = Router();

  // Used by the "Neu laden" button next to an expired PDF preview: re-authorizes the current
  // session against the job (not the old signature) and mints a fresh short-lived signed URL,
  // so a browser idle past PDF_PREVIEW_TTL_SECONDS doesn't need a full page reload.
  router.get('/:jobId/refresh-url', requireLogin(), (req, res) => {
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

  // Same authorization as /:jobId/refresh-url — any session that may see this job's PDF may
  // also see its thumbnail (dashboard table, Pool section included). Session-authenticated,
  // unlike the PDF stream below (which uses a signed URL so n8n can fetch it without a session).
  router.get('/:jobId/thumbnail', requireLogin(), (req, res) => {
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

  router.get('/:jobId', (req, res) => {
    const jobId = Number(req.params.jobId);
    const { expires, signature } = req.query;

    if (!verifySignedDownload(config, jobId, expires, signature)) {
      return res.status(403).json(GENERIC_DENIAL);
    }

    const job = getJobById(db, jobId);
    if (!job || !existsSync(job.pdf_pfad)) {
      return res.status(403).json(GENERIC_DENIAL);
    }

    const stream = createReadStream(job.pdf_pfad);
    stream.on('error', () => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      // res.type() below already primed the Content-Type header for the happy path;
      // reset it explicitly here so this error response is a real application/json
      // 403 like every other denial, not application/pdf with a JSON body.
      res.status(403).type('json').json(GENERIC_DENIAL);
    });
    res.type('application/pdf');
    // Without an explicit Content-Disposition, some browsers (and browser/OS PDF-handling
    // policies) fall back to downloading the file instead of rendering it in the <iframe>
    // preview used by pool.ejs, kontierung.ejs, and freigabe2.ejs. "inline" plus a sanitized
    // filename (CR/LF stripped, quotes escaped) makes every browser render it in place.
    const safeName = job.dateiname.replace(/[\r\n"]/g, '');
    res.setHeader('Content-Disposition', `inline; filename="${safeName}"`);
    // A chunked response with no Content-Length is a known trigger for some PDF viewers
    // (notably Safari/iOS) to fall back to a download prompt instead of rendering inline —
    // setting it explicitly removes that ambiguity for every browser.
    res.setHeader('Content-Length', statSync(job.pdf_pfad).size);
    stream.pipe(res);
  });

  return router;
}
