import { Router } from 'express';
import { createReadStream, existsSync } from 'node:fs';
import { listPoolJobs, claimJob, getJobById } from '../db/jobsRepo.js';

export function createPoolRouter({ db }) {
  const router = Router();

  router.get('/', (req, res) => {
    const jobs = listPoolJobs(db).map((job) => ({
      id: job.id,
      eingang_am: job.eingang_am,
      quelle: job.quelle,
      absender: job.absender,
      dateiname: job.dateiname,
      status: job.status,
      konto_id: job.konto_id,
      zugewiesen_an: job.zugewiesen_an,
    }));
    res.json(jobs);
  });

  router.post('/:id/beanspruchen', (req, res) => {
    const claimed = claimJob(db, Number(req.params.id), req.currentPerson.churchtools_person_id);
    if (!claimed) {
      return res.status(409).json({ error: 'Job ist nicht mehr im Pool verfügbar.' });
    }
    res.json({ id: Number(req.params.id), status: 'zugewiesen' });
  });

  router.get('/:id/thumbnail', (req, res) => {
    const job = getJobById(db, Number(req.params.id));
    // Scoped the same way every sibling route in this file already is: a thumbnail is only
    // servable while the job is still unclaimed in the pool, or to the person it's currently
    // assigned to — never to any Buchhaltung member for any job by guessing an ID.
    const authorized =
      job && (job.status === 'unzugewiesen' || job.zugewiesen_an === req.currentPerson.churchtools_person_id);
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

  return router;
}
