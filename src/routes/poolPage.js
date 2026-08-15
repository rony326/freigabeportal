import { Router } from 'express';
import { listPoolJobs, listZugewiesenJobsForPerson, listFreigabe2JobsForPerson, listAbgelehntJobsForPerson } from '../db/jobsRepo.js';
import { buildSignedDownloadUrl, PDF_PREVIEW_TTL_SECONDS } from '../services/downloadUrl.js';

export function createPoolPageRouter({ db, config }) {
  const router = Router();

  router.get('/', (req, res) => {
    const personId = req.currentPerson.churchtools_person_id;
    const poolJobs = listPoolJobs(db).map((job) => ({
      ...job,
      previewUrl: buildSignedDownloadUrl(config, job.id, PDF_PREVIEW_TTL_SECONDS),
    }));
    res.render('pool', {
      poolJobs,
      meineKontierungen: listZugewiesenJobsForPerson(db, personId),
      meineFreigaben: listFreigabe2JobsForPerson(db, personId),
      meineAbgelehnten: listAbgelehntJobsForPerson(db, personId),
    });
  });

  return router;
}
