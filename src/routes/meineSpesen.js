import { Router } from 'express';
import { listSpesenForEinreicher } from '../db/jobsRepo.js';
import { getKontoById } from '../db/kontenRepo.js';
import { kommentarInfoFuer } from '../services/kommentare.js';

export function createMeineSpesenRouter({ db, config }) {
  const router = Router();

  router.get('/', (req, res) => {
    const personId = req.currentPerson.churchtools_person_id;
    const jobs = listSpesenForEinreicher(db, personId).map((job) => ({
      ...job,
      kontonummer: job.konto_id ? (getKontoById(db, job.konto_id)?.kontonummer ?? null) : null,
    }));
    res.render('meine-spesen', { jobs, kommentarInfo: kommentarInfoFuer(db, config, req.currentPerson, jobs.map((j) => j.id)) });
  });

  return router;
}
