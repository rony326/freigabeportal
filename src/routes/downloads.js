import { Router } from 'express';
import { createReadStream, existsSync } from 'node:fs';
import { getJobById } from '../db/jobsRepo.js';
import { verifySignedDownload } from '../services/downloadUrl.js';

const GENERIC_DENIAL = { error: 'Link ungültig oder abgelaufen.' };

export function createDownloadsRouter({ db, config }) {
  const router = Router();

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
    stream.pipe(res);
  });

  return router;
}
