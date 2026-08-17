import { Router } from 'express';
import { existsSync, unlinkSync } from 'node:fs';
import { getJobById, listAlleAbgelehntenJobs, loeschenJob } from '../../db/jobsRepo.js';
import { getPersonById } from '../../db/personenRepo.js';
import { logJobLoeschung } from '../../db/jobLoeschungenRepo.js';

export function createAdminAbgelehntRouter({ db }) {
  const router = Router();

  router.get('/', (req, res) => {
    const jobs = listAlleAbgelehntenJobs(db).map((job) => ({
      ...job,
      abgelehntVonPerson: getPersonById(db, job.abgelehnt_von),
    }));
    res.render('admin/abgelehnt-liste', { jobs, gespeichert: req.query.gespeichert === '1' });
  });

  router.get('/:id', (req, res) => {
    const job = getJobById(db, Number(req.params.id));
    if (!job || job.status !== 'abgelehnt') {
      return res.status(404).render('error', { message: 'Diese Rechnung ist nicht (mehr) abgelehnt oder existiert nicht.' });
    }
    res.render('admin/abgelehnt-loeschen', { job, errors: [], begruendung: '' });
  });

  router.post('/:id/loeschen', (req, res, next) => {
    try {
      const job = getJobById(db, Number(req.params.id));
      if (!job || job.status !== 'abgelehnt') {
        return res.status(404).render('error', { message: 'Diese Rechnung ist nicht (mehr) abgelehnt oder existiert nicht.' });
      }

      const { begruendung, bestaetigung } = req.body;
      const errors = [];
      if (!begruendung || !begruendung.trim()) {
        errors.push('Eine Begründung ist Pflicht.');
      }
      if (bestaetigung !== 'ja') {
        errors.push('Bitte die Löschung bestätigen.');
      }
      if (errors.length > 0) {
        return res.status(400).render('admin/abgelehnt-loeschen', { job, errors, begruendung: begruendung || '' });
      }

      db.exec('BEGIN');
      let geloescht;
      try {
        geloescht = loeschenJob(db, job.id);
        if (geloescht) {
          logJobLoeschung(db, {
            jobId: geloescht.id,
            dateiname: geloescht.dateiname,
            geloeschtVon: req.currentPerson.churchtools_person_id,
            begruendung: begruendung.trim(),
          });
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }

      if (!geloescht) {
        return res.status(409).render('error', { message: 'Diese Rechnung wurde inzwischen bereits anderweitig bearbeitet (z.B. überarbeitet).' });
      }

      try {
        if (geloescht.pdf_pfad && existsSync(geloescht.pdf_pfad)) unlinkSync(geloescht.pdf_pfad);
      } catch (err) {
        console.error(`Löschen der PDF für Job ${geloescht.id} fehlgeschlagen:`, err.message);
      }
      try {
        if (geloescht.thumbnail_pfad && existsSync(geloescht.thumbnail_pfad)) unlinkSync(geloescht.thumbnail_pfad);
      } catch (err) {
        console.error(`Löschen des Thumbnails für Job ${geloescht.id} fehlgeschlagen:`, err.message);
      }

      res.redirect('/admin/abgelehnt?gespeichert=1');
    } catch (err) {
      next(err);
    }
  });

  return router;
}
