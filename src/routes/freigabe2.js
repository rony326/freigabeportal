import { Router } from 'express';
import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { getJobById, eskalierenFreigabe2, eskalierenFreigabe2AnAdmin, abschliessenFreigabe2, ablehnenJob, getEffectiveFreigeber2Id } from '../db/jobsRepo.js';
import { getKontoById } from '../db/kontenRepo.js';
import { createFreigabe, listFreigabenByJob } from '../db/freigabenRepo.js';
import { getPersonById } from '../db/personenRepo.js';
import { getConfigValue } from '../db/adminConfigRepo.js';
import { stampAndFinalize } from '../services/pdfStamp.js';
import { buildSignedDownloadUrl, PDF_PREVIEW_TTL_SECONDS } from '../services/downloadUrl.js';
import { sendNotification, resolveEmpfaenger } from '../services/notify.js';

export function createFreigabe2Router({ db, config, mailer }) {
  const router = Router();

  function isPortalAdmin(person) {
    return Boolean(person && person.gruppen.includes(String(config.churchtools.groupIdAdmin)));
  }

  function loadAuthorized(req, res) {
    const job = getJobById(db, Number(req.params.id));
    if (!job || job.status !== 'freigabe2') {
      res.status(403).render('error', { message: 'Für diesen Job ist aktuell keine Freigabe 2 möglich.' });
      return null;
    }
    const konto = getKontoById(db, job.konto_id);
    const authorized =
      konto &&
      (job.freigabe2_eskaliert_an_admin
        ? isPortalAdmin(req.currentPerson)
        : getEffectiveFreigeber2Id(job, konto) === req.currentPerson.churchtools_person_id);
    if (!authorized) {
      res.status(403).render('error', { message: 'Du bist für die Freigabe 2 dieses Jobs nicht zuständig.' });
      return null;
    }
    // Vier-Augen-Prinzip: the Konto's role assignment is only checked at admin-edit time
    // (validateKontoRoles), which is a point-in-time check on the Konto row, not on this
    // specific job. If the Konto is edited while a job sits in freigabe2 — or the same person
    // holds both Buchhaltung and Portal-Admin — the person who already approved Freigabe 1
    // could otherwise end up as the resolved Freigabe-2 approver too. Re-check per job.
    const freigabe1 = listFreigabenByJob(db, job.id).findLast((f) => f.rolle === 'freigeber1');
    if (freigabe1 && freigabe1.person_id === req.currentPerson.churchtools_person_id) {
      res.status(403).render('error', {
        message: 'Du hast diese Rechnung bereits in Freigabe 1 freigegeben und kannst sie nicht auch in Freigabe 2 freigeben (Vier-Augen-Prinzip).',
      });
      return null;
    }
    return { job, konto };
  }

  function renderForm(req, res, status, { job, konto }, values, errors) {
    const freigaben = listFreigabenByJob(db, job.id);
    const freigabe1 = freigaben.findLast((f) => f.rolle === 'freigeber1');
    if (!freigabe1) {
      return res.status(500).render('error', { message: 'Freigabe 1 fehlt für diesen Job — bitte an den Portal-Admin wenden.' });
    }
    const freigeber1Person = getPersonById(db, freigabe1.person_id);
    res.status(status).render('freigabe2', {
      job,
      konto,
      freigabe1,
      freigeber1Person,
      previewUrl: buildSignedDownloadUrl(config, job.id, PDF_PREVIEW_TTL_SECONDS),
      values,
      errors,
    });
  }

  router.get('/:id', (req, res) => {
    const result = loadAuthorized(req, res);
    if (!result) return;
    renderForm(req, res, 200, result, { interessenskonflikt: '', begruendung: '' }, []);
  });

  router.post('/:id', async (req, res, next) => {
    try {
      const result = loadAuthorized(req, res);
      if (!result) return;
      const { job, konto } = result;
      const { aktion, interessenskonflikt, begruendung } = req.body;
      const hatKonflikt = interessenskonflikt === 'ja';

      if (hatKonflikt && !begruendung) {
        return renderForm(req, res, 400, result, { interessenskonflikt, begruendung }, ['Bei einem Interessenskonflikt ist eine Begründung Pflicht.']);
      }

      if (hatKonflikt && aktion === 'ablehnen') {
        return renderForm(req, res, 400, result, { interessenskonflikt, begruendung }, [
          'Bitte entweder einen Interessenskonflikt melden oder die Rechnung ablehnen — nicht beides gleichzeitig.',
        ]);
      }

      if (hatKonflikt) {
        // SYNC-8: job.freigabe2_eskaliert_von being already set here means this job was already
        // escalated once — and per loadAuthorized, the only person who could reach this line for
        // an already-escalated job is that Tier-1 escalated Stellvertreter2 themselves, now also
        // declaring their own conflict. Route to Portal-Admin instead of blocking.
        const eskaliertAnAdmin = Boolean(job.freigabe2_eskaliert_von);

        db.exec('BEGIN');
        try {
          if (eskaliertAnAdmin) {
            eskalierenFreigabe2AnAdmin(db, job.id, { eskaliertVon: req.currentPerson.churchtools_person_id, grund: begruendung });
          } else {
            eskalierenFreigabe2(db, job.id, { eskaliertVon: req.currentPerson.churchtools_person_id, grund: begruendung });
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
              subject: 'Freigabeportal: Interessenskonflikt bei Freigabe 2 – an Portal-Admin eskaliert',
              text: `Eine Rechnung wurde an die Portal-Admin-Gruppe eskaliert, da auch die Stellvertretung einen Interessenskonflikt erklärt hat: ${job.dateiname}\n\nBitte im Freigabeportal anmelden: ${config.publicBaseUrl}/freigabe2/${job.id}`,
              typ: 'zuweisung',
              jobId: job.id,
            });
          }
        } else {
          const stellvertreter2 = getPersonById(db, konto.stellvertreter2_id);
          if (stellvertreter2) {
            await sendNotification(db, mailer, {
              to: stellvertreter2.email,
              subject: 'Freigabeportal: Interessenskonflikt bei Freigabe 2 – an dich übergeben',
              text: `Eine Rechnung wurde dir zur Freigabe 2 übergeben, da ${req.currentPerson.vorname} ${req.currentPerson.nachname} einen Interessenskonflikt erklärt hat: ${job.dateiname}\n\nBitte im Freigabeportal anmelden: ${config.publicBaseUrl}/freigabe2/${job.id}`,
              typ: 'zuweisung',
              jobId: job.id,
            });
          }
        }
        return res.redirect('/pool');
      }

      if (aktion === 'ablehnen') {
        if (!begruendung) {
          return renderForm(req, res, 400, result, { interessenskonflikt, begruendung }, ['Bei einer Ablehnung ist eine Begründung Pflicht.']);
        }
        db.exec('BEGIN');
        try {
          const abgelehnt = ablehnenJob(db, job.id, { abgelehntVon: req.currentPerson.churchtools_person_id, grund: begruendung });
          if (!abgelehnt) {
            db.exec('ROLLBACK');
            return renderForm(req, res, 409, result, { interessenskonflikt, begruendung }, [
              'Diese Freigabe wurde inzwischen bereits von einem anderen Vorgang bearbeitet.',
            ]);
          }
          createFreigabe(db, {
            jobId: job.id,
            personId: req.currentPerson.churchtools_person_id,
            rolle: 'ablehnung',
            zeitpunkt: new Date().toISOString(),
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
        if (job.freigabe1_eskaliert_an_admin) {
          const empfaenger = resolveEmpfaenger(db, config, 'gruppe:admin');
          for (const email of empfaenger) {
            await sendNotification(db, mailer, {
              to: email,
              subject: 'Freigabeportal: Rechnung abgelehnt (an Portal-Admin eskaliert)',
              text: `Eine an die Portal-Admin-Gruppe eskalierte Rechnung wurde abgelehnt: ${job.dateiname}\n\nGrund: ${begruendung}\n\nBitte im Freigabeportal anmelden, um sie zu überarbeiten: ${config.publicBaseUrl}/abgelehnt/${job.id}`,
              typ: 'ablehnung',
              jobId: job.id,
            });
          }
        } else {
          const besitzer = getPersonById(db, job.zugewiesen_an);
          if (besitzer) {
            await sendNotification(db, mailer, {
              to: besitzer.email,
              subject: 'Freigabeportal: Rechnung abgelehnt',
              text: `Deine Rechnung wurde abgelehnt: ${job.dateiname}\n\nGrund: ${begruendung}\n\nBitte im Freigabeportal anmelden, um sie zu überarbeiten: ${config.publicBaseUrl}/abgelehnt/${job.id}`,
              typ: 'ablehnung',
              jobId: job.id,
            });
          }
        }
        return res.redirect('/pool');
      }

      const freigaben = listFreigabenByJob(db, job.id);
      const freigabe1 = freigaben.findLast((f) => f.rolle === 'freigeber1');
      const freigeber1Person = getPersonById(db, freigabe1.person_id);
      const zeitpunkt = new Date().toISOString();
      const freigeber2Eintrag = {
        name: `${req.currentPerson.vorname} ${req.currentPerson.nachname}`,
        identitaet: req.currentPerson.churchtools_person_id,
        zeitpunkt,
        ip: req.ip,
        interessenskonflikt: false,
        kommentar: null,
      };
      const stampData = {
        freigeber1: {
          name: `${freigeber1Person.vorname} ${freigeber1Person.nachname}`,
          identitaet: freigeber1Person.churchtools_person_id,
          zeitpunkt: freigabe1.zeitpunkt,
          ip: freigabe1.ip,
          interessenskonflikt: Boolean(freigabe1.interessenskonflikt),
          kommentar: freigabe1.kommentar,
        },
        freigeber2: freigeber2Eintrag,
        // `freigaben` was loaded before this request's own freigeber2 approval is persisted
        // (that insert happens later, atomically alongside abschliessenFreigabe2). Without
        // appending it here, the Verlauf page on the final stamped PDF would omit the very
        // approval that completed the job.
        verlauf: [
          ...freigaben.map((f) => {
            const person = getPersonById(db, f.person_id);
            return {
              rolleLabel: { freigeber1: 'Freigabe 1', freigeber2: 'Freigabe 2', ablehnung: 'Abgelehnt' }[f.rolle],
              name: `${person.vorname} ${person.nachname}`,
              identitaet: f.person_id,
              zeitpunkt: f.zeitpunkt,
              ip: f.ip,
              interessenskonflikt: Boolean(f.interessenskonflikt),
              kommentar: f.kommentar,
            };
          }),
          { rolleLabel: 'Freigabe 2', ...freigeber2Eintrag },
        ],
      };

      const pdfBuffer = readFileSync(job.pdf_pfad);
      let stamped;
      try {
        const position = getConfigValue(db, 'visum_seite_position') || 'letzte';
        stamped = await stampAndFinalize(pdfBuffer, stampData, position);
      } catch (err) {
        return renderForm(req, res, 400, result, { interessenskonflikt, begruendung }, [err.message]);
      }

      const tmpPfad = `${job.pdf_pfad}.${randomUUID()}.tmp`;
      writeFileSync(tmpPfad, stamped);

      db.exec('BEGIN');
      try {
        createFreigabe(db, {
          jobId: job.id,
          personId: req.currentPerson.churchtools_person_id,
          rolle: 'freigeber2',
          zeitpunkt,
          ip: req.ip,
          interessenskonflikt: false,
          kommentar: null,
          eskaliertVon: job.freigabe2_eskaliert_von,
        });
        const abgeschlossen = abschliessenFreigabe2(db, job.id);
        if (!abgeschlossen) {
          db.exec('ROLLBACK');
          try { unlinkSync(tmpPfad); } catch { /* best-effort cleanup of the losing attempt's tmp file */ }
          return renderForm(req, res, 409, result, { interessenskonflikt, begruendung }, [
            'Diese Freigabe wurde inzwischen bereits von einem anderen Vorgang abgeschlossen.',
          ]);
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        try { unlinkSync(tmpPfad); } catch { /* best-effort cleanup */ }
        throw err;
      }

      try {
        renameSync(tmpPfad, job.pdf_pfad);
      } catch (err) {
        // The job is already committed abgeschlossen at this point — a failed rename here would
        // otherwise leave it eligible for n8n pickup with the original, unstamped PDF (no Visum,
        // no audit trail) instead of crashing the request. Log loudly so it's noticed rather
        // than silently shipping the wrong file.
        console.error(`Stempel-PDF für Job ${job.id} konnte nicht final abgelegt werden:`, err.message);
      }
      res.redirect('/pool');
    } catch (err) {
      next(err);
    }
  });

  return router;
}
