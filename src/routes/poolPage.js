import { Router } from 'express';
import { listPoolJobs, listZugewiesenJobsForPerson, listFreigabe2JobsForPerson, listAbgelehntJobsForPerson } from '../db/jobsRepo.js';
import { buildSignedDownloadUrl, PDF_PREVIEW_TTL_SECONDS } from '../services/downloadUrl.js';

export function createPoolPageRouter({ db, config }) {
  const router = Router();

  function mitPreviewUrl(jobs) {
    return jobs.map((job) => ({ ...job, previewUrl: buildSignedDownloadUrl(config, job.id, PDF_PREVIEW_TTL_SECONDS) }));
  }

  router.get('/', (req, res) => {
    const personId = req.currentPerson.churchtools_person_id;
    res.render('pool', {
      poolJobs: mitPreviewUrl(listPoolJobs(db)),
      meineKontierungen: mitPreviewUrl(listZugewiesenJobsForPerson(db, personId)),
      meineFreigaben: mitPreviewUrl(listFreigabe2JobsForPerson(db, personId)),
      meineAbgelehnten: mitPreviewUrl(listAbgelehntJobsForPerson(db, personId)),
    });
  });

  return router;
}
