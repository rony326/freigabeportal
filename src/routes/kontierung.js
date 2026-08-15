import { Router } from 'express';
import { getJobById, setKontierung, eskalierenFreigabe1, abschliessenFreigabe1, releaseJob } from '../db/jobsRepo.js';
import { listKontenForPerson } from '../db/kontenRepo.js';
import { createFreigabe } from '../db/freigabenRepo.js';
import { buildSignedDownloadUrl, PDF_PREVIEW_TTL_SECONDS } from '../services/downloadUrl.js';

export function createKontierungRouter({ db, config }) {
  const router = Router();

  function loadAuthorizedJob(req, res) {
    const job = getJobById(db, Number(req.params.id));
    if (!job || job.zugewiesen_an !== req.currentPerson.churchtools_person_id || job.status !== 'zugewiesen') {
      res.status(403).render('error', { message: 'Dieser Job ist dir aktuell nicht zur Kontierung zugewiesen.' });
      return null;
    }
    return job;
  }

  router.get('/:id', (req, res) => {
    const job = loadAuthorizedJob(req, res);
    if (!job) return;
    const konten = listKontenForPerson(db, req.currentPerson.churchtools_person_id);
    res.render('kontierung', {
      job,
      konten,
      previewUrl: buildSignedDownloadUrl(config, job.id, PDF_PREVIEW_TTL_SECONDS),
      values: { kontoId: job.konto_id ? String(job.konto_id) : '', interessenskonflikt: '', begruendung: '' },
      errors: [],
    });
  });

  router.post('/:id', (req, res) => {
    const job = loadAuthorizedJob(req, res);
    if (!job) return;
    const konten = listKontenForPerson(db, req.currentPerson.churchtools_person_id);
    const { kontoId, interessenskonflikt, begruendung } = req.body;
    const errors = [];

    const konto = konten.find((k) => String(k.id) === kontoId);
    if (!konto) {
      errors.push('Bitte ein gültiges Konto aus der Liste auswählen.');
    }
    const hatKonflikt = interessenskonflikt === 'ja';
    if (hatKonflikt && !begruendung) {
      errors.push('Bei einem Interessenskonflikt ist eine Begründung Pflicht.');
    }
    if (hatKonflikt && job.freigabe1_eskaliert_von) {
      errors.push('Diese Aufgabe wurde bereits eskaliert und kann nicht erneut eskaliert werden. Bitte lege sie zurück in den Pool oder wende dich an den Portal-Admin.');
    }

    if (errors.length > 0) {
      return res.status(400).render('kontierung', {
        job,
        konten,
        previewUrl: buildSignedDownloadUrl(config, job.id, PDF_PREVIEW_TTL_SECONDS),
        values: { kontoId, interessenskonflikt, begruendung },
        errors,
      });
    }

    db.exec('BEGIN');
    try {
      setKontierung(db, job.id, konto.id);
      if (hatKonflikt) {
        eskalierenFreigabe1(db, job.id, { eskaliertVon: req.currentPerson.churchtools_person_id, grund: begruendung, stellvertreterId: konto.stellvertreter1_id });
      } else {
        createFreigabe(db, {
          jobId: job.id,
          personId: req.currentPerson.churchtools_person_id,
          rolle: 'freigeber1',
          zeitpunkt: new Date().toISOString(),
          ip: req.ip,
          interessenskonflikt: false,
          kommentar: null,
          eskaliertVon: job.freigabe1_eskaliert_von,
        });
        abschliessenFreigabe1(db, job.id);
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    res.redirect('/pool');
  });

  router.post('/:id/zurueck-in-pool', (req, res) => {
    const job = loadAuthorizedJob(req, res);
    if (!job) return;
    releaseJob(db, job.id, req.currentPerson.churchtools_person_id);
    res.redirect('/pool');
  });

  return router;
}
