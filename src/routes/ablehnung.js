import { Router } from 'express';
import { getJobById, wiederOeffnenJob } from '../db/jobsRepo.js';
import { getPersonById } from '../db/personenRepo.js';

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
    res.render('abgelehnt', { job, abgelehntVonPerson });
  });

  router.post('/:id/ueberarbeiten', (req, res) => {
    const job = loadAuthorizedJob(req, res);
    if (!job) return;
    wiederOeffnenJob(db, job.id, req.currentPerson.churchtools_person_id);
    res.redirect(`/kontierung/${job.id}`);
  });

  return router;
}
