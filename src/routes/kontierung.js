import { Router } from 'express';
import { getJobById, setKontierung, eskalierenFreigabe1, eskalierenFreigabe1AnAdmin, abschliessenFreigabe1, releaseJob, getEffectiveFreigeber2Id } from '../db/jobsRepo.js';
import { listKontenForPerson, getKontoById } from '../db/kontenRepo.js';
import { createFreigabe } from '../db/freigabenRepo.js';
import { buildSignedDownloadUrl, PDF_PREVIEW_TTL_SECONDS } from '../services/downloadUrl.js';
import { getPersonById } from '../db/personenRepo.js';
import { sendNotification, resolveEmpfaenger } from '../services/notify.js';

export function createKontierungRouter({ db, config, mailer }) {
  const router = Router();

  function isPortalAdmin(person) {
    return Boolean(person && person.gruppen.includes(String(config.churchtools.groupIdAdmin)));
  }

  function loadAuthorizedJob(req, res) {
    const job = getJobById(db, Number(req.params.id));
    if (!job || job.status !== 'zugewiesen') {
      res.status(403).render('error', { message: 'Dieser Job ist dir aktuell nicht zur Kontierung zugewiesen.' });
      return null;
    }
    const authorized = job.freigabe1_eskaliert_an_admin
      ? isPortalAdmin(req.currentPerson)
      : job.zugewiesen_an === req.currentPerson.churchtools_person_id;
    if (!authorized) {
      res.status(403).render('error', { message: 'Dieser Job ist dir aktuell nicht zur Kontierung zugewiesen.' });
      return null;
    }
    return job;
  }

  // The form's existing pre-fill (values.kontoId defaults to job.konto_id) already assumes the
  // job's currently-assigned Konto is the expected resubmission target. listKontenForPerson
  // alone is role-filtered, though, and a Portal-Admin resolving a self-escalated job (case B in
  // the POST handler below) holds no freigeber1/stellvertreter1 role on that Konto BY
  // DEFINITION — that's exactly what made it a self-escalation. Without this, such an admin
  // could view the form (200) but never submit it: the dropdown has nothing selectable and
  // konten.find(...) in the POST handler always fails. Unconditional, not gated on
  // freigabe1_eskaliert_an_admin, since it's a no-op for the normal case: the job's Konto is
  // already in a legitimately-role-holding person's own listKontenForPerson result.
  function ladeKontenFuerJob(req, job) {
    const konten = listKontenForPerson(db, req.currentPerson.churchtools_person_id);
    if (job.konto_id && !konten.some((k) => k.id === job.konto_id)) {
      const bestehendes = getKontoById(db, job.konto_id);
      if (bestehendes) konten.push(bestehendes);
    }
    return konten;
  }

  router.get('/:id', (req, res) => {
    const job = loadAuthorizedJob(req, res);
    if (!job) return;
    const konten = ladeKontenFuerJob(req, job);
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
      const konten = ladeKontenFuerJob(req, job);
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

      if (errors.length > 0) {
        return res.status(400).render('kontierung', {
          job,
          konten,
          previewUrl: buildSignedDownloadUrl(config, job.id, PDF_PREVIEW_TTL_SECONDS),
          values: { kontoId, interessenskonflikt, begruendung },
          errors,
        });
      }

      // SYNC-8: a conflict-driven escalation has no distinct named person to hand off to in two
      // cases — this job was already escalated once (so the only person who could even reach
      // this line, per loadAuthorizedJob, is the previously-escalated Stellvertreter1, and they
      // ALSO have a conflict), or the chosen Konto's stellvertreter1 IS the current person
      // (escalating would target themselves). Both route to the Portal-Admin group instead of
      // blocking with the old "go back to pool / contact admin" dead end.
      const eskaliertAnAdmin = hatKonflikt && Boolean(job.freigabe1_eskaliert_von || konto.stellvertreter1_id === req.currentPerson.churchtools_person_id);

      db.exec('BEGIN');
      try {
        setKontierung(db, job.id, konto.id);
        if (eskaliertAnAdmin) {
          eskalierenFreigabe1AnAdmin(db, job.id, { eskaliertVon: req.currentPerson.churchtools_person_id, grund: begruendung });
        } else if (hatKonflikt) {
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

      if (eskaliertAnAdmin) {
        const empfaenger = resolveEmpfaenger(db, config, 'gruppe:admin');
        for (const email of empfaenger) {
          await sendNotification(db, mailer, {
            to: email,
            subject: 'Freigabeportal: Interessenskonflikt bei Freigabe 1 – an Portal-Admin eskaliert',
            text: `Eine Rechnung wurde an die Portal-Admin-Gruppe eskaliert, da auch die Stellvertretung einen Interessenskonflikt erklärt hat: ${job.dateiname}\n\nBitte im Freigabeportal anmelden: ${config.publicBaseUrl}/kontierung/${job.id}`,
            typ: 'zuweisung',
            jobId: job.id,
          });
        }
      } else if (hatKonflikt) {
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
        const freigeber2 = getPersonById(db, getEffectiveFreigeber2Id(job, konto));
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
    // Use job.zugewiesen_an, not req.currentPerson.churchtools_person_id: releaseJob's guard
    // requires zugewiesen_an to match the person passed in, and for a Portal-Admin authorized
    // via the freigabe1_eskaliert_an_admin branch, the admin's own ID never equals
    // job.zugewiesen_an (still the excluded Stellvertreter1's ID) — passing the admin's ID would
    // silently match zero rows while still redirecting to /pool as if it had succeeded. For the
    // ordinary (non-admin) path this is definitionally identical, since loadAuthorizedJob already
    // verified job.zugewiesen_an === req.currentPerson.churchtools_person_id to get here.
    releaseJob(db, job.id, job.zugewiesen_an);
    res.redirect('/pool');
  });

  return router;
}
