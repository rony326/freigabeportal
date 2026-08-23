import { Router } from 'express';
import {
  listPoolJobs,
  listZugewiesenJobsForPerson,
  listFreigabe2JobsForPerson,
  listAbgelehntJobsForPerson,
  listAdminEskalierteKontierungen,
  listAdminEskalierteFreigaben,
  listAbgeschlossenJobsForPerson,
} from '../db/jobsRepo.js';
import { getKontoById } from '../db/kontenRepo.js';
import { buildSignedDownloadUrl, PDF_PREVIEW_TTL_SECONDS } from '../services/downloadUrl.js';
import { personHasRole } from '../middleware/roles.js';

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
    // /pool is reachable by every logged-in person now (see app.js), but the company-wide pool of
    // unassigned invoices is still Buchhaltung/Portal-Admin business — skip the query entirely for
    // anyone else rather than relying on pool.ejs alone to hide it.
    const zeigtPool = personHasRole(req.currentPerson, config, 'buchhaltung') || personHasRole(req.currentPerson, config, 'portal-admin');
    const istPortalAdmin = personHasRole(req.currentPerson, config, 'portal-admin');
    res.render('pool', {
      poolJobs: zeigtPool ? enrich(listPoolJobs(db)) : [],
      meineKontierungen: enrich(listZugewiesenJobsForPerson(db, personId)),
      meineFreigaben: enrich(listFreigabe2JobsForPerson(db, personId)),
      meineAbgelehnten: enrich(listAbgelehntJobsForPerson(db, personId)),
      adminEskalierteKontierungen: istPortalAdmin ? enrich(listAdminEskalierteKontierungen(db)) : [],
      adminEskalierteFreigaben: istPortalAdmin ? enrich(listAdminEskalierteFreigaben(db)) : [],
      // Deliberately NOT run through enrich(): _abgeschlossen_table.ejs renders only dateiname,
      // status and zeitstempel_gesetzt_am — it has neither a thumbnail/preview link nor a Konto
      // column, unlike the _job_table.ejs-backed sections above. enrich() would mint a signed
      // download URL and do a getKontoById query per row for values nothing ever reads.
      meineAbgeschlossenen: listAbgeschlossenJobsForPerson(db, personId),
    });
  });

  return router;
}
