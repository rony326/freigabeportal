import { Router } from 'express';
import { mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  getJobById,
  setKontierung,
  updateKontierungMetadaten,
  ablehnenJob,
  eskalierenFreigabe1,
  eskalierenFreigabe1AnAdmin,
  abschliessenFreigabe1,
  releaseJob,
  getEffectiveFreigeber2Id,
  markJobAufgesplittet,
  createSplitJob,
  setJobBetrag,
} from '../db/jobsRepo.js';
import { listKontenForPerson, getKontoById } from '../db/kontenRepo.js';
import { listDebitoren, getDebitorById, createDebitor } from '../db/debitorenRepo.js';
import { createFreigabe } from '../db/freigabenRepo.js';
import { buildSignedDownloadUrl, PDF_PREVIEW_TTL_SECONDS } from '../services/downloadUrl.js';
import { getPersonById } from '../db/personenRepo.js';
import { sendNotification, resolveEmpfaenger } from '../services/notify.js';
import { buildAuditLog } from '../services/auditLog.js';

const BETRAG_PATTERN = /^\d+([.,]\d{1,2})?$/;
const ZAHLUNGSZIEL_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function neuerDateipfad(jobsDir, quelldatei) {
  mkdirSync(jobsDir, { recursive: true });
  const endung = quelldatei.slice(quelldatei.lastIndexOf('.'));
  const zielPfad = join(jobsDir, `job-${Date.now()}-${Math.random().toString(36).slice(2)}${endung}`);
  copyFileSync(quelldatei, zielPfad);
  return zielPfad;
}

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
      debitoren: listDebitoren(db),
      previewUrl: buildSignedDownloadUrl(config, job.id, PDF_PREVIEW_TTL_SECONDS),
      values: {
        kontoId: job.konto_id ? String(job.konto_id) : '',
        interessenskonflikt: '',
        begruendung: '',
        absender: job.absender || '',
        betrag: job.betrag || '',
        zahlungsziel: job.zahlungsziel || '',
        rechnungsnummer: job.rechnungsnummer || '',
        debitorId: job.debitor_id ? String(job.debitor_id) : '',
      },
      errors: [],
      auditLog: buildAuditLog(db, job.id),
    });
  });

  // Must be registered before the generic /:id routes below — otherwise POST
  // /kontierung/lieferanten would first match /:id (with id="lieferanten", a NaN Number()) and
  // 404/403 before ever reaching this handler. Open to any logged-in Kontierung user (not just
  // Portal-Admins), since Kontierung itself is usually done by Buchhaltung, not admins — mirrors
  // the validation in POST /admin/debitoren, minus the admin-only gate.
  router.post('/lieferanten', (req, res) => {
    const { name, kontoId } = req.body;
    const trimmedName = (name || '').trim();
    if (!trimmedName) {
      return res.status(400).json({ error: 'Name ist ein Pflichtfeld.' });
    }
    const id = createDebitor(db, { name: trimmedName, kontoId: kontoId ? Number(kontoId) : null });
    res.status(201).json({ id, name: trimmedName });
  });

  router.post('/:id', async (req, res, next) => {
    try {
      const job = loadAuthorizedJob(req, res);
      if (!job) return;
      const konten = ladeKontenFuerJob(req, job);
      const debitoren = listDebitoren(db);
      const { kontoId, interessenskonflikt, begruendung, absender, betrag, zahlungsziel, rechnungsnummer, debitorId, aktion } = req.body;
      const values = { kontoId, interessenskonflikt, begruendung, absender, betrag, zahlungsziel, rechnungsnummer, debitorId };

      if (aktion === 'ablehnen') {
        if (!begruendung) {
          return res.status(400).render('kontierung', {
            job,
            konten,
            debitoren,
            previewUrl: buildSignedDownloadUrl(config, job.id, PDF_PREVIEW_TTL_SECONDS),
            values,
            errors: ['Bei einer Ablehnung ist eine Begründung Pflicht.'],
            auditLog: buildAuditLog(db, job.id),
          });
        }

        db.exec('BEGIN');
        let abgelehnt;
        try {
          abgelehnt = ablehnenJob(db, job.id, { abgelehntVon: req.currentPerson.churchtools_person_id, grund: begruendung });
          if (abgelehnt) {
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
          }
          db.exec('COMMIT');
        } catch (err) {
          db.exec('ROLLBACK');
          throw err;
        }

        if (!abgelehnt) {
          return res.status(409).render('kontierung', {
            job,
            konten,
            debitoren,
            previewUrl: buildSignedDownloadUrl(config, job.id, PDF_PREVIEW_TTL_SECONDS),
            values,
            errors: ['Diese Rechnung wurde inzwischen bereits von einem anderen Vorgang bearbeitet.'],
            auditLog: buildAuditLog(db, job.id),
          });
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
        }

        return res.redirect('/pool');
      }

      const errors = [];

      const konto = konten.find((k) => String(k.id) === kontoId);
      if (!konto) {
        errors.push('Bitte ein gültiges Konto aus der Liste auswählen.');
      }
      const hatKonflikt = interessenskonflikt === 'ja';
      if (hatKonflikt && !begruendung) {
        errors.push('Bei einem Interessenskonflikt ist eine Begründung Pflicht.');
      }
      if (betrag && !BETRAG_PATTERN.test(betrag)) {
        errors.push('Betrag muss eine gültige Zahl sein (z.B. 123.45).');
      }
      if (zahlungsziel && (!ZAHLUNGSZIEL_PATTERN.test(zahlungsziel) || Number.isNaN(new Date(zahlungsziel).getTime()))) {
        errors.push('Zahlungsziel ist kein gültiges Datum.');
      }

      if (errors.length > 0) {
        return res.status(400).render('kontierung', {
          job,
          konten,
          debitoren,
          previewUrl: buildSignedDownloadUrl(config, job.id, PDF_PREVIEW_TTL_SECONDS),
          values,
          errors,
          auditLog: buildAuditLog(db, job.id),
        });
      }

      const debitor = debitorId ? getDebitorById(db, debitorId) : null;

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
        updateKontierungMetadaten(db, job.id, {
          absender,
          betrag: betrag ? betrag.replace(',', '.') : null,
          zahlungsziel,
          rechnungsnummer,
          lieferant: debitor ? debitor.name : null,
          debitorId: debitor ? debitor.id : null,
        });
        if (eskaliertAnAdmin) {
          createFreigabe(db, {
            jobId: job.id,
            personId: req.currentPerson.churchtools_person_id,
            rolle: 'freigabe1_eskalation',
            zeitpunkt: new Date().toISOString(),
            ip: req.ip,
            interessenskonflikt: true,
            kommentar: begruendung,
            eskaliertVon: job.freigabe1_eskaliert_von,
          });
          eskalierenFreigabe1AnAdmin(db, job.id, { eskaliertVon: req.currentPerson.churchtools_person_id, grund: begruendung });
        } else if (hatKonflikt) {
          createFreigabe(db, {
            jobId: job.id,
            personId: req.currentPerson.churchtools_person_id,
            rolle: 'freigabe1_eskalation',
            zeitpunkt: new Date().toISOString(),
            ip: req.ip,
            interessenskonflikt: true,
            kommentar: begruendung,
            eskaliertVon: job.freigabe1_eskaliert_von,
          });
          eskalierenFreigabe1(db, job.id, { eskaliertVon: req.currentPerson.churchtools_person_id, grund: begruendung, stellvertreterId: konto.stellvertreter1_id });
        } else {
          createFreigabe(db, {
            jobId: job.id,
            personId: req.currentPerson.churchtools_person_id,
            rolle: 'freigeber1',
            zeitpunkt: new Date().toISOString(),
            ip: req.ip,
            interessenskonflikt: false,
            kommentar: begruendung || null,
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
            text: `Eine Rechnung wurde dir zur Kontierung übergeben, da ${req.currentPerson.vorname} ${req.currentPerson.nachname} einen Interessenskonflikt erklärt hat: ${job.dateiname}\n\nBitte im Freigabeportal anmelden: ${config.publicBaseUrl}/kontierung/${job.id}`,
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
            text: `Eine Rechnung wartet auf deine Freigabe 2: ${job.dateiname}\n\nBitte im Freigabeportal anmelden: ${config.publicBaseUrl}/freigabe2/${job.id}`,
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

  function renderAufsplittenForm(req, res, status, job, konten, gesamtbetrag, teile, errors) {
    res.status(status).render('kontierung-aufsplitten', { job, konten, gesamtbetrag, teile, errors });
  }

  router.get('/:id/aufsplitten', (req, res) => {
    const job = loadAuthorizedJob(req, res);
    if (!job) return;
    const konten = ladeKontenFuerJob(req, job);
    renderAufsplittenForm(req, res, 200, job, konten, job.betrag || '', [
      { kontoId: '', betrag: '' },
      { kontoId: '', betrag: '' },
    ], []);
  });

  router.post('/:id/aufsplitten', async (req, res, next) => {
    try {
      const job = loadAuthorizedJob(req, res);
      if (!job) return;
      const konten = ladeKontenFuerJob(req, job);

      const gesamtbetrag = req.body.gesamtbetrag || '';
      const kontoIds = [].concat(req.body.teilKontoId || []);
      const betraege = [].concat(req.body.teilBetrag || []);
      const teileEingabe = kontoIds.map((kontoId, i) => ({ kontoId, betrag: betraege[i] || '' }));

      const errors = [];
      if (!gesamtbetrag || !BETRAG_PATTERN.test(gesamtbetrag)) {
        errors.push('Bitte einen gültigen Gesamtbetrag erfassen (z.B. 200.00).');
      }
      if (teileEingabe.filter((t) => t.kontoId || t.betrag).length < 2) {
        errors.push('Mindestens zwei Teilbeträge sind nötig, um aufzusplitten.');
      }

      const aufgeloesteTeile = [];
      for (const teil of teileEingabe) {
        if (!teil.kontoId && !teil.betrag) continue;
        const konto = konten.find((k) => String(k.id) === teil.kontoId);
        if (!konto) {
          errors.push('Bitte für jede Zeile ein gültiges Konto auswählen.');
          continue;
        }
        if (!teil.betrag || !BETRAG_PATTERN.test(teil.betrag)) {
          errors.push('Jede Zeile braucht einen gültigen Betrag (z.B. 123.45).');
          continue;
        }
        aufgeloesteTeile.push({ konto, betrag: teil.betrag.replace(',', '.') });
      }

      if (errors.length === 0) {
        const summe = aufgeloesteTeile.reduce((sum, t) => sum + Number(t.betrag), 0);
        const original = Number(gesamtbetrag.replace(',', '.'));
        if (Math.abs(summe - original) > 0.005) {
          errors.push(`Die Summe der Teilbeträge (${summe.toFixed(2)}) muss dem Gesamtbetrag (${original.toFixed(2)}) entsprechen.`);
        }
      }

      if (errors.length > 0) {
        return renderAufsplittenForm(req, res, 400, job, konten, gesamtbetrag, teileEingabe, errors);
      }

      // Persisted on the parent even though it's about to be retired: the parent may never have
      // had a Betrag saved before (that's exactly the gap this Gesamtbetrag field closes), and
      // its own record should reflect the real total the split was based on, not stay empty.
      job.betrag = gesamtbetrag.replace(',', '.');

      db.exec('BEGIN');
      const kinder = [];
      try {
        setJobBetrag(db, job.id, job.betrag);
        const markiert = markJobAufgesplittet(db, job.id);
        if (!markiert) {
          db.exec('ROLLBACK');
          return res.status(409).render('error', { message: 'Diese Rechnung wurde inzwischen bereits von einem anderen Vorgang bearbeitet.' });
        }
        for (const teil of aufgeloesteTeile) {
          const pdfPfad = neuerDateipfad(config.jobsDir, job.pdf_pfad);
          const thumbnailPfad = job.thumbnail_pfad ? neuerDateipfad(config.jobsDir, job.thumbnail_pfad) : null;
          const kindId = createSplitJob(db, job, {
            pdfPfad,
            thumbnailPfad,
            kontoId: teil.konto.id,
            betrag: teil.betrag,
            zugewiesenAn: req.currentPerson.churchtools_person_id,
          });
          createFreigabe(db, {
            jobId: kindId,
            personId: req.currentPerson.churchtools_person_id,
            rolle: 'freigeber1',
            zeitpunkt: new Date().toISOString(),
            ip: req.ip,
            interessenskonflikt: false,
            kommentar: null,
            eskaliertVon: null,
          });
          abschliessenFreigabe1(db, kindId);
          kinder.push({ id: kindId, konto: teil.konto });
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }

      for (const { id: kindId, konto } of kinder) {
        const kindJob = getJobById(db, kindId);
        const freigeber2 = getPersonById(db, getEffectiveFreigeber2Id(kindJob, konto));
        if (freigeber2) {
          await sendNotification(db, mailer, {
            to: freigeber2.email,
            subject: 'Freigabeportal: Neue Rechnung zur Freigabe 2',
            text: `Eine Rechnung wartet auf deine Freigabe 2: ${kindJob.dateiname}\n\nBitte im Freigabeportal anmelden: ${config.publicBaseUrl}/freigabe2/${kindJob.id}`,
            typ: 'zuweisung',
            jobId: kindJob.id,
          });
        }
      }

      res.redirect('/pool');
    } catch (err) {
      next(err);
    }
  });

  return router;
}
