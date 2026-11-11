// JSON-Schnittstelle des Pools (`/api/pool`, nur Buchhaltung, mit Sitzung): Liste der unzugewiesenen Vorgänge und "beanspruchen" per fetch() (CSRF über den Header `x-csrf-token`).

import { Router } from 'express';
import { listPoolJobs, claimJob } from '../db/jobsRepo.js';

export function createPoolRouter({ db, csrfProtection = (req, res, next) => next() }) {
  const router = Router();

  // GET /api/pool – die unzugewiesenen Vorgänge (nur Kernfelder).
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

  // POST /api/pool/:id/beanspruchen – Person beansprucht den Vorgang (409, wenn schon vergeben).
  router.post('/:id/beanspruchen', csrfProtection, (req, res) => {
    const claimed = claimJob(db, Number(req.params.id), req.currentPerson.churchtools_person_id);
    if (!claimed) {
      return res.status(409).json({ error: 'Job ist nicht mehr im Pool verfügbar.' });
    }
    res.json({ id: Number(req.params.id), status: 'zugewiesen' });
  });

  return router;
}
