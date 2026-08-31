import { Router } from 'express';
import {
  getJobById,
  eskalierenFreigabe1,
  eskalierenFreigabe1AnAdmin,
  abschliessenFreigabe1,
  eskalierenFreigabe2,
  ablehnenJob,
  getEffectiveFreigeber2Id,
} from '../db/jobsRepo.js';
import { getKontoById } from '../db/kontenRepo.js';
import { createFreigabe } from '../db/freigabenRepo.js';
import { getPersonById } from '../db/personenRepo.js';
import { buildSignedDownloadUrl, PDF_PREVIEW_TTL_SECONDS } from '../services/downloadUrl.js';
import { sendNotification, resolveEmpfaenger } from '../services/notify.js';
import { buildAuditLog } from '../services/auditLog.js';

export function createSpesenFreigabe1Router({ db, config, mailer, csrfProtection = (req, res, next) => next() }) {
  const router = Router();

  function isSuperadmin(person) {
    return Boolean(person && person.gruppen.includes(String(config.churchtools.groupIdAdmin)));
  }

  function loadAuthorized(req, res) {
    const job = getJobById(db, Number(req.params.id));
    if (!job || job.quelle !== 'spesen' || job.status !== 'zugewiesen') {
      res.status(403).render('error', { message: 'Für diese Spesen-Position ist aktuell keine Freigabe 1 möglich.' });
      return null;
    }
    // Must be checked unconditionally, before the admin-escalation branch below: a superadmin
    // who is also this claim's own submitter must never be authorized here just because the
    // admin-escalated branch only checks group membership. Reachable via: submitter is this
    // Konto's own Freigeber1 -> auto-escalates to Stellvertreter1 at submission -> Stellvertreter1
    // also declares a conflict -> since freigabe1_eskaliert_von is already set, that second
    // conflict routes straight to the admin group (SYNC-8), where the submitter — if also a
    // superadmin — would otherwise pass isSuperadmin() and approve their own claim.
    if (job.eingereicht_von === req.currentPerson.churchtools_person_id) {
      res.status(403).render('error', {
        message: 'Du hast diese Spesen-Position selbst eingereicht und kannst sie nicht selbst freigeben.',
      });
      return null;
    }
    const authorized = job.freigabe1_eskaliert_an_admin
      ? isSuperadmin(req.currentPerson)
      : job.zugewiesen_an === req.currentPerson.churchtools_person_id;
    if (!authorized) {
      res.status(403).render('error', { message: 'Diese Spesen-Position ist dir aktuell nicht zur Prüfung zugewiesen.' });
      return null;
    }
    return { job, konto: getKontoById(db, job.konto_id) };
  }

  function renderForm(req, res, status, { job, konto }, values, errors) {
    res.status(status).render('spesen-freigabe1', {
      job,
      konto,
      eingereichtePerson: getPersonById(db, job.eingereicht_von),
      previewUrl: buildSignedDownloadUrl(config, job.id, PDF_PREVIEW_TTL_SECONDS),
      values,
      errors,
      auditLog: buildAuditLog(db, job.id),
    });
  }

  router.get('/:id', (req, res) => {
    const result = loadAuthorized(req, res);
    if (!result) return;
    renderForm(req, res, 200, result, { interessenskonflikt: '', begruendung: '' }, []);
  });

  router.post('/:id', csrfProtection, async (req, res, next) => {
    try {
      const result = loadAuthorized(req, res);
      if (!result) return;
      const { job, konto } = result;
      const { aktion, interessenskonflikt, begruendung } = req.body;
      const hatKonflikt = interessenskonflikt === 'ja';
      const values = { interessenskonflikt: interessenskonflikt || '', begruendung: begruendung || '' };

      if ((hatKonflikt || aktion === 'ablehnen') && !begruendung) {
        return renderForm(req, res, 400, result, values, ['Begründung ist bei Interessenskonflikt oder Ablehnung Pflicht.']);
      }

      const zeitpunkt = new Date().toISOString();

      if (aktion === 'ablehnen') {
        db.exec('BEGIN');
        try {
          const abgelehnt = ablehnenJob(db, job.id, { abgelehntVon: req.currentPerson.churchtools_person_id, grund: begruendung });
          if (!abgelehnt) {
            db.exec('ROLLBACK');
            return res.status(409).render('error', { message: 'Diese Spesen-Position wurde inzwischen bereits bearbeitet.' });
          }
          createFreigabe(db, {
            jobId: job.id,
            personId: req.currentPerson.churchtools_person_id,
            rolle: 'ablehnung',
            zeitpunkt,
            ip: req.ip,
            interessenskonflikt: false,
            kommentar: begruendung,
            eskaliertVon: null,
          });
          db.exec('COMMIT');
        } catch (err) {
          db.exec('ROLLBACK');
          throw err;
        }
        const einreicher = getPersonById(db, job.eingereicht_von);
        if (einreicher) {
          await sendNotification(db, mailer, {
            to: einreicher.email,
            subject: 'Freigabeportal: Spesen-Position abgelehnt',
            text: `Deine Spesen-Position wurde abgelehnt: ${job.dateiname}\n\nBegründung: ${begruendung}`,
            typ: 'ablehnung',
            jobId: job.id,
          });
        }
        return res.redirect('/pool');
      }

      if (hatKonflikt) {
        const eskaliertAnAdmin = Boolean(job.freigabe1_eskaliert_von || konto.stellvertreter1_id === req.currentPerson.churchtools_person_id);
        db.exec('BEGIN');
        try {
          createFreigabe(db, {
            jobId: job.id,
            personId: req.currentPerson.churchtools_person_id,
            rolle: 'freigabe1_eskalation',
            zeitpunkt,
            ip: req.ip,
            interessenskonflikt: true,
            kommentar: begruendung,
            eskaliertVon: job.freigabe1_eskaliert_von,
          });
          if (eskaliertAnAdmin) {
            eskalierenFreigabe1AnAdmin(db, job.id, { eskaliertVon: req.currentPerson.churchtools_person_id, grund: begruendung });
          } else {
            eskalierenFreigabe1(db, job.id, {
              eskaliertVon: req.currentPerson.churchtools_person_id,
              grund: begruendung,
              stellvertreterId: konto.stellvertreter1_id,
            });
          }
          db.exec('COMMIT');
        } catch (err) {
          db.exec('ROLLBACK');
          throw err;
        }
        if (eskaliertAnAdmin) {
          for (const email of resolveEmpfaenger(db, config, 'gruppe:admin')) {
            await sendNotification(db, mailer, {
              to: email,
              subject: 'Freigabeportal: Interessenskonflikt bei Spesen-Freigabe 1 – an Portal-Admin eskaliert',
              text: `Eine Spesen-Position wurde an die Portal-Admin-Gruppe eskaliert, da auch die Stellvertretung einen Interessenskonflikt erklärt hat: ${job.dateiname}\n\nBitte im Freigabeportal anmelden: ${config.publicBaseUrl}/spesen-freigabe1/${job.id}`,
              typ: 'zuweisung',
              jobId: job.id,
            });
          }
        } else {
          const stellvertreter1 = getPersonById(db, konto.stellvertreter1_id);
          if (stellvertreter1) {
            await sendNotification(db, mailer, {
              to: stellvertreter1.email,
              subject: 'Freigabeportal: Interessenskonflikt bei Spesen-Freigabe 1 – Prüfung an dich übergeben',
              text: `Eine Spesen-Position wurde dir zur Prüfung übergeben, da ${req.currentPerson.vorname} ${req.currentPerson.nachname} einen Interessenskonflikt erklärt hat: ${job.dateiname}\n\nBitte im Freigabeportal anmelden: ${config.publicBaseUrl}/spesen-freigabe1/${job.id}`,
              typ: 'zuweisung',
              jobId: job.id,
            });
          }
        }
        return res.redirect('/pool');
      }

      db.exec('BEGIN');
      try {
        createFreigabe(db, {
          jobId: job.id,
          personId: req.currentPerson.churchtools_person_id,
          rolle: 'freigeber1',
          zeitpunkt,
          ip: req.ip,
          interessenskonflikt: false,
          kommentar: begruendung || null,
          eskaliertVon: job.freigabe1_eskaliert_von,
        });
        abschliessenFreigabe1(db, job.id);
        // Vier-Augen-Prinzip, second half: Freigabe 1 just completed, but if the submitter of
        // this Spesen position is ALSO this Konto's own Freigeber2, letting the job proceed
        // unmodified would resolve back to the submitter for Freigabe 2 too (getEffectiveFreigeber2Id
        // would pick konto.freigeber2_id === job.eingereicht_von). Reroute to Stellvertreter2 right
        // here, atomically with the Freigabe-1 completion, rather than ever reaching Freigabe 2 with
        // no valid non-self approver (see freigabe2.js's loadAuthorized submitter check, which is
        // the belt-and-suspenders backstop for this same rule).
        if (job.quelle === 'spesen' && konto.freigeber2_id === job.eingereicht_von) {
          eskalierenFreigabe2(db, job.id, { eskaliertVon: job.eingereicht_von, grund: 'Selbsteinreichung durch Freigeber2' });
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      const aktualisierterJob = getJobById(db, job.id);
      const freigeber2 = getPersonById(db, getEffectiveFreigeber2Id(aktualisierterJob, konto));
      if (freigeber2) {
        await sendNotification(db, mailer, {
          to: freigeber2.email,
          subject: 'Freigabeportal: Neue Spesen-Position zur Freigabe 2',
          text: `Eine Spesen-Position wartet auf deine Freigabe 2: ${job.dateiname}\n\nBitte im Freigabeportal anmelden: ${config.publicBaseUrl}/freigabe2/${job.id}`,
          typ: 'zuweisung',
          jobId: job.id,
        });
      }
      res.redirect('/pool');
    } catch (err) {
      next(err);
    }
  });

  return router;
}
