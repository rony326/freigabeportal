import { Router } from 'express';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { getJobById, getEffectiveFreigeber2Id } from '../db/jobsRepo.js';
import { getKontoById } from '../db/kontenRepo.js';
import { buildSignedDownloadUrl, verifySignedDownload, PDF_PREVIEW_TTL_SECONDS } from '../services/downloadUrl.js';
import { requireLogin, personHasRole } from '../middleware/roles.js';

const GENERIC_DENIAL = { error: 'Link ungültig oder abgelaufen.' };

// Mirrors the per-page authorization each job-detail route already enforces (loadAuthorizedJob
// in kontierung.js/ablehnung.js, loadAuthorized in freigabe2.js, the Pool gate in poolPage.js) —
// this only decides whether a fresh preview link may be minted for the *current* session, it does
// not replace those routes' own checks.
function canViewJobPdf(db, config, currentPerson, job) {
  if (personHasRole(currentPerson, config, 'portal-admin')) return true;
  if (job.status === 'unzugewiesen') return personHasRole(currentPerson, config, 'buchhaltung');
  const personId = currentPerson.churchtools_person_id;
  if (job.zugewiesen_an === personId) return true;
  if (job.konto_id) {
    const konto = getKontoById(db, job.konto_id);
    if (konto && getEffectiveFreigeber2Id(job, konto) === personId) return true;
  }
  return false;
}

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
