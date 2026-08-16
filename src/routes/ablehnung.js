import { Router } from 'express';
import { getJobById, wiederOeffnenJob } from '../db/jobsRepo.js';
import { getPersonById } from '../db/personenRepo.js';
import { listFreigabenByJob } from '../db/freigabenRepo.js';

export function createAblehnungRouter({ db }) {
  const router = Router();

  function loadAuthorizedJob(req, res) {
    const job = getJobById(db, Number(req.params.id));
    if (!job || job.zugewiesen_an !== req.currentPerson.churchtools_person_id || job.status !== 'abgelehnt') {
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
    const reopened = wiederOeffnenJob(db, job.id, req.currentPerson.churchtools_person_id);
    if (!reopened) {
      return res.status(409).render('error', { message: 'Diese Rechnung wurde inzwischen bereits von einem anderen Vorgang bearbeitet.' });
    }
    res.redirect(`/kontierung/${job.id}`);
  });

  return router;
}
