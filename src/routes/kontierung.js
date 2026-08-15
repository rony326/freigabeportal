import { Router } from 'express';
import { getJobById, setKontierung, eskalierenFreigabe1, abschliessenFreigabe1, releaseJob } from '../db/jobsRepo.js';
import { listKontenForPerson } from '../db/kontenRepo.js';
import { createFreigabe } from '../db/freigabenRepo.js';
import { buildSignedDownloadUrl, PDF_PREVIEW_TTL_SECONDS } from '../services/downloadUrl.js';
import { getPersonById } from '../db/personenRepo.js';
import { sendNotification } from '../services/notify.js';

export function createKontierungRouter({ db, config, mailer }) {
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

  router.post('/:id', async (req, res, next) => {
    try {
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
      if (hatKonflikt && konto && konto.stellvertreter1_id === req.currentPerson.churchtools_person_id) {
        errors.push('Du bist bereits die Stellvertretung für dieses Konto und kannst nicht an dich selbst eskalieren. Bitte lege den Job zurück in den Pool oder wende dich an den Portal-Admin.');
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

      if (hatKonflikt) {
        const stellvertreter1 = getPersonById(db, konto.stellvertreter1_id);
        if (stellvertreter1) {
          await sendNotification(db, mailer, {
            to: stellvertreter1.email,
            subject: 'Freigabeportal: Interessenskonflikt bei Freigabe 1 – Kontierung an dich übergeben',
            text: `Eine Rechnung wurde dir zur Kontierung übergeben, da ${req.currentPerson.vorname} ${req.currentPerson.nachname} einen Interessenskonflikt erklärt hat: ${job.dateiname}\n\nBitte im Freigabeportal anmelden: ${config.publicBaseUrl}/pool`,
            typ: 'zuweisung',
            jobId: job.id,
          });
        }
      } else {
        const freigeber2 = getPersonById(db, konto.freigeber2_id);
        if (freigeber2) {
          await sendNotification(db, mailer, {
            to: freigeber2.email,
            subject: 'Freigabeportal: Neue Rechnung zur Freigabe 2',
            text: `Eine Rechnung wartet auf deine Freigabe 2: ${job.dateiname}\n\nBitte im Freigabeportal anmelden: ${config.publicBaseUrl}/pool`,
            typ: 'zuweisung',
            jobId: job.id,
          });
        }
      }

      res.redirect('/pool');
    } catch (err) {
      next(err);
    }
  });

  router.post('/:id/zurueck-in-pool', (req, res) => {
    const job = loadAuthorizedJob(req, res);
    if (!job) return;
    releaseJob(db, job.id, req.currentPerson.churchtools_person_id);
    res.redirect('/pool');
  });

  return router;
}
