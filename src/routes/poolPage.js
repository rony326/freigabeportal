import { Router } from 'express';
import { listPoolJobs, listZugewiesenJobsForPerson, listFreigabe2JobsForPerson, listAbgelehntJobsForPerson } from '../db/jobsRepo.js';
import { getKontoById } from '../db/kontenRepo.js';
import { buildSignedDownloadUrl, PDF_PREVIEW_TTL_SECONDS } from '../services/downloadUrl.js';

export function createPoolPageRouter({ db, config }) {
  const router = Router();

  function enrich(jobs) {
    return jobs.map((job) => ({
      ...job,
      previewUrl: buildSignedDownloadUrl(config, job.id, PDF_PREVIEW_TTL_SECONDS),
      kontonummer: job.konto_id ? (getKontoById(db, job.konto_id)?.kontonummer ?? null) : null,
    }));
  }

  router.get('/', (req, res) => {
    const personId = req.currentPerson.churchtools_person_id;
    res.render('pool', {
      poolJobs: enrich(listPoolJobs(db)),
      meineKontierungen: enrich(listZugewiesenJobsForPerson(db, personId)),
      meineFreigaben: enrich(listFreigabe2JobsForPerson(db, personId)),
      meineAbgelehnten: enrich(listAbgelehntJobsForPerson(db, personId)),
    });
  });

  return router;
}
