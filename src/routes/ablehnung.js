import { Router } from 'express';
import { getJobById, wiederOeffnenJob } from '../db/jobsRepo.js';
import { getPersonById } from '../db/personenRepo.js';
import { listFreigabenByJob } from '../db/freigabenRepo.js';

export function createAblehnungRouter({ db, config }) {
  const router = Router();

  function isPortalAdmin(person) {
    return Boolean(person && person.gruppen.includes(String(config.churchtools.groupIdAdmin)));
  }

  function loadAuthorizedJob(req, res) {
    const job = getJobById(db, Number(req.params.id));
    if (!job || job.status !== 'abgelehnt') {
      res.status(403).render('error', { message: 'Dieser Job ist für dich aktuell nicht zur Überarbeitung verfügbar.' });
      return null;
    }
    const authorized = job.freigabe1_eskaliert_an_admin
      ? isPortalAdmin(req.currentPerson)
      : job.zugewiesen_an === req.currentPerson.churchtools_person_id;
    if (!authorized) {
      res.status(403).render('error', { message: 'Dieser Job ist für dich aktuell nicht zur Überarbeitung verfügbar.' });
      return null;
    }
    return job;
  }

  router.get('/:id', (req, res) => {
    const job = loadAuthorizedJob(req, res);
    if (!job) return;
    const abgelehntVonPerson = getPersonById(db, job.abgelehnt_von);
    const ablehnung = listFreigabenByJob(db, job.id).findLast((f) => f.rolle === 'ablehnung');
    res.render('abgelehnt', { job, abgelehntVonPerson, ablehnung });
  });

  router.post('/:id/ueberarbeiten', (req, res) => {
    const job = loadAuthorizedJob(req, res);
    if (!job) return;
    // Use job.zugewiesen_an, not req.currentPerson.churchtools_person_id: wiederOeffnenJob's
    // guard requires zugewiesen_an to match the person passed in, and for a Portal-Admin
    // authorized via the freigabe1_eskaliert_an_admin branch, the admin's own ID never equals
    // job.zugewiesen_an (still the excluded Stellvertreter1's ID) — passing the admin's ID would
    // silently match zero rows while still returning the generic 409 as if a race had occurred.
    // For the ordinary (non-admin) path this is definitionally identical, since
    // loadAuthorizedJob already verified job.zugewiesen_an === req.currentPerson.churchtools_person_id
    // to get here. Mirrors the identical fix already applied to kontierung.js's zurueck-in-pool
    // route in Batch 3.
    const reopened = wiederOeffnenJob(db, job.id, job.zugewiesen_an);
    if (!reopened) {
      return res.status(409).render('error', { message: 'Diese Rechnung wurde inzwischen bereits von einem anderen Vorgang bearbeitet.' });
    }
    res.redirect(`/kontierung/${job.id}`);
  });

  return router;
}
