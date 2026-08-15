import { Router } from 'express';
import { listPoolJobs, claimJob } from '../db/jobsRepo.js';

export function createPoolRouter({ db }) {
  const router = Router();

  router.get('/', (req, res) => {
    res.json(listPoolJobs(db));
  });

  router.post('/:id/beanspruchen', (req, res) => {
    const claimed = claimJob(db, Number(req.params.id), req.currentPerson.churchtools_person_id);
    if (!claimed) {
      return res.status(409).json({ error: 'Job ist nicht mehr im Pool verfügbar.' });
    }
    res.json({ id: Number(req.params.id), status: 'zugewiesen' });
  });

  return router;
}
