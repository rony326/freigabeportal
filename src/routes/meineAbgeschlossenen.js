import { Router } from 'express';
import { listAbgeschlossenJobsForPerson } from '../db/jobsRepo.js';

export function createMeineAbgeschlossenenRouter({ db }) {
  const router = Router();

  router.get('/', (req, res) => {
    const personId = req.currentPerson.churchtools_person_id;
    const seiteAngefragt = Math.max(1, Number(req.query.seite) || 1);
    const { jobs, gesamtAnzahl, seite, proSeite } = listAbgeschlossenJobsForPerson(db, personId, { seite: seiteAngefragt });

    res.render('meine-abgeschlossenen', {
      jobs,
      gesamtAnzahl,
      seite,
      proSeite,
      gesamtSeiten: Math.max(1, Math.ceil(gesamtAnzahl / proSeite)),
    });
  });

  return router;
}
