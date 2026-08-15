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

    res.type('application/pdf');
    createReadStream(job.pdf_pfad).pipe(res);
  });

  return router;
}
