import { Router } from 'express';
import { readFileSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { getJobById, eskalierenFreigabe2, eskalierenFreigabe2AnAdmin, abschliessenFreigabe2, ablehnenJob, getEffectiveFreigeber2Id, markZeitstempelGesetzt } from '../db/jobsRepo.js';
import { getKontoById } from '../db/kontenRepo.js';
import { getSpesenabrechnungById } from '../db/spesenabrechnungenRepo.js';
import { createFreigabe, listFreigabenByJob } from '../db/freigabenRepo.js';
import { getPersonById } from '../db/personenRepo.js';
import { getConfigValue } from '../db/adminConfigRepo.js';
import { stampAndFinalize } from '../services/pdfStamp.js';
import { setZeitstempel } from '../services/zeitstempel.js';
import { fetchPersonById, extractCustomFieldValue } from '../services/churchtools.js';
import { validateSpesenPayment, paymentReviewFingerprint } from '../services/paymentApproval.js';
import { buildSignedDownloadUrl, PDF_PREVIEW_TTL_SECONDS } from '../services/downloadUrl.js';
import { sendNotification, sendNotificationMitVertretung, resolveEmpfaenger } from '../services/notify.js';
import { istAktiveVertretungFuer } from '../services/vertretung.js';
import { buildAuditLog, EREIGNIS_LABEL } from '../services/auditLog.js';
import { pruefeUndFinalisiereSplitGruppe } from '../services/splitGruppenExport.js';
import { kkHinweisFuerJob } from '../services/kkStempel.js';
import { writeFinalDocument } from '../services/finalDocument.js';
import { tsaTrustOptions } from '../services/tsaTrust.js';

export function createFreigabe2Router({ db, config, mailer, csrfProtection = (req, res, next) => next() }) {
  const router = Router();

  function isSuperadmin(person) {
    return Boolean(person && person.gruppen.includes(String(config.churchtools.groupIdAdmin)));
  }

  function loadAuthorized(req, res) {
    const job = getJobById(db, Number(req.params.id));
    if (!job || job.status !== 'freigabe2') {
      res.status(403).render('error', { message: 'Für diesen Job ist aktuell keine Freigabe 2 möglich.' });
      return null;
    }
    const konto = getKontoById(db, job.konto_id);
    const effektiverFreigeber2 = konto ? getEffectiveFreigeber2Id(job, konto) : null;
    const authorized =
      konto &&
      (job.freigabe2_eskaliert_an_admin
        ? isSuperadmin(req.currentPerson)
        : effektiverFreigeber2 === req.currentPerson.churchtools_person_id ||
          istAktiveVertretungFuer(db, req.currentPerson.churchtools_person_id, effektiverFreigeber2));
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
    // Belt-and-suspenders: spesenFreigabe1.js's "Freigeben" branch already reroutes a Spesen
    // position to Stellvertreter2 the instant Freigabe 1 completes, whenever the submitter is
    // this Konto's own Freigeber2 — so getEffectiveFreigeber2Id should never resolve back to the
    // submitter in the first place. This is a direct, independent check in case that reroute is
    // ever bypassed (a bug, a future code path creating a Spesen job without going through
    // spesenFreigabe1.js) — the core guarantee (never approve your own claim) must hold either way.
    if (job.quelle === 'spesen' && job.eingereicht_von === req.currentPerson.churchtools_person_id) {
      res.status(403).render('error', {
        message: 'Du hast diese Spesen-Position selbst eingereicht und kannst sie nicht selbst freigeben.',
      });
      return null;
    }
    return { job, konto };
  }

  function renderForm(req, res, status, { job, konto }, values, errors, paymentReview = null) {
    const freigaben = listFreigabenByJob(db, job.id);
    const freigabe1 = freigaben.findLast((f) => f.rolle === 'freigeber1');
    if (!freigabe1) {
      return res.status(500).render('error', { message: 'Freigabe 1 fehlt für diesen Job — bitte an den Portal-Admin wenden.' });
    }
    const freigeber1Person = getPersonById(db, freigabe1.person_id);
    const spesenEinreicher = job.quelle === 'spesen' ? getPersonById(db, job.eingereicht_von) : null;
    const spesenabrechnungTitel = job.quelle === 'spesen' ? getSpesenabrechnungById(db, job.spesenabrechnung_id)?.titel || null : null;
    res.status(status).render('freigabe2', {
      job,
      konto,
      freigabe1,
      freigeber1Person,
      spesenEinreicher,
      spesenabrechnungTitel,
      previewUrl: buildSignedDownloadUrl(config, job.id, PDF_PREVIEW_TTL_SECONDS),
      values,
      errors,
      paymentReview,
      auditLog: buildAuditLog(db, job.id),
      kkHinweis: kkHinweisFuerJob(db, job),
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
          createFreigabe(db, {
            jobId: job.id,
            personId: req.currentPerson.churchtools_person_id,
            rolle: 'freigabe2_eskalation',
            zeitpunkt: new Date().toISOString(),
            ip: req.ip,
            interessenskonflikt: true,
            kommentar: begruendung,
            eskaliertVon: job.freigabe2_eskaliert_von,
          });
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
              typ: 'zuweisung',
              jobId: job.id,
              variablen: {
                empfaengerName: 'Portal-Admin-Team',
                jobDateiname: job.dateiname,
                grund: 'Eine Rechnung wurde an die Portal-Admin-Gruppe eskaliert, da auch die Stellvertretung einen Interessenskonflikt erklärt hat.',
                link: `${config.publicBaseUrl}/freigabe2/${job.id}`,
              },
            });
          }
        } else {
          const stellvertreter2 = getPersonById(db, konto.stellvertreter2_id);
          if (stellvertreter2) {
            await sendNotification(db, mailer, {
              to: stellvertreter2.email,
              typ: 'zuweisung',
              jobId: job.id,
              variablen: {
                empfaengerName: `${stellvertreter2.vorname} ${stellvertreter2.nachname}`,
                jobDateiname: job.dateiname,
                grund: `Eine Rechnung wurde dir zur Freigabe 2 übergeben, da ${req.currentPerson.vorname} ${req.currentPerson.nachname} einen Interessenskonflikt erklärt hat.`,
                link: `${config.publicBaseUrl}/freigabe2/${job.id}`,
              },
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
          const effektiverFreigeber2FuerAblehnung = getEffectiveFreigeber2Id(job, konto);
          createFreigabe(db, {
            jobId: job.id,
            personId: req.currentPerson.churchtools_person_id,
            rolle: 'ablehnung',
            zeitpunkt: new Date().toISOString(),
            ip: req.ip,
            interessenskonflikt: false,
            kommentar: begruendung,
            eskaliertVon: null,
            vertretungFuer:
              !job.freigabe2_eskaliert_an_admin && istAktiveVertretungFuer(db, req.currentPerson.churchtools_person_id, effektiverFreigeber2FuerAblehnung)
                ? effektiverFreigeber2FuerAblehnung
                : null,
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
              typ: 'ablehnung',
              jobId: job.id,
              variablen: {
                empfaengerName: 'Portal-Admin-Team',
                jobDateiname: job.dateiname,
                grund: 'Eine an die Portal-Admin-Gruppe eskalierte Rechnung wurde abgelehnt:',
                begruendung,
                link: `${config.publicBaseUrl}/abgelehnt/${job.id}`,
              },
            });
          }
        } else {
          const besitzer = getPersonById(db, job.zugewiesen_an);
          if (besitzer) {
            await sendNotificationMitVertretung(db, mailer, {
              person: besitzer,
              typ: 'ablehnung',
              jobId: job.id,
              variablen: {
                jobDateiname: job.dateiname,
                grund: 'Deine Rechnung wurde abgelehnt:',
                begruendung,
                link: `${config.publicBaseUrl}/abgelehnt/${job.id}`,
              },
            });
          }
        }
        return res.redirect('/pool');
      }

      const freigaben = listFreigabenByJob(db, job.id);
      const freigabe1 = freigaben.findLast((f) => f.rolle === 'freigeber1');
      const freigeber1Person = getPersonById(db, freigabe1.person_id);
      const zeitpunkt = new Date().toISOString();

      // Plain local DB reads, unlike the live ChurchTools lookup below — a Spesen position has
      // no separate invoice date, so its Titel (Spesenabrechnung) and Verwendungszweck are what
      // identify the document on the permanently archived stamp page.
      const titel = job.quelle === 'spesen' ? getSpesenabrechnungById(db, job.spesenabrechnung_id)?.titel || null : null;
      const verwendungszweck = job.quelle === 'spesen' ? job.beschreibung || null : null;

      let zahlungsdaten = null;
      if (job.quelle === 'spesen' && job.eingereicht_von) {
        try {
          const einreicher = await fetchPersonById(config.churchtools, config.churchtools.syncServiceToken, job.eingereicht_von);
          const ibanRoh = extractCustomFieldValue(einreicher, config.churchtools.customFieldIban);
          zahlungsdaten = validateSpesenPayment(ibanRoh, extractCustomFieldValue(einreicher, config.churchtools.customFieldKontoinhaber));
        } catch (err) {
          console.error(`Zahlungsdaten-Abruf fuer Job ${job.id} fehlgeschlagen; Freigabe gesperrt.`);
        }
      }
      if (job.quelle === 'spesen') {
        if (!zahlungsdaten) {
          return renderForm(req, res, 400, result, { interessenskonflikt, begruendung }, ['Freigabe gesperrt: Eine gueltige Schweizer IBAN und der Kontoinhaber muessen in ChurchTools hinterlegt und abrufbar sein.']);
        }
        const fingerprint = paymentReviewFingerprint(job, konto, zahlungsdaten, req.currentPerson.churchtools_person_id);
        if (req.body.zahlungsdaten_bestaetigt !== 'ja' || req.body.zahlungsdaten_stand !== fingerprint) {
          const changed = Boolean(req.body.zahlungsdaten_stand);
          return renderForm(req, res, changed ? 409 : 400, result, { interessenskonflikt, begruendung },
            [changed ? 'Der Zahlungs- oder Vorgangsstand wurde geaendert. Bitte erneut pruefen und bestaetigen.' : 'Bitte die Zahlungsdaten pruefen und bestaetigen.'],
            { ...zahlungsdaten, fingerprint });
        }
      }

      const freigeber2Eintrag = {
        name: `${req.currentPerson.vorname} ${req.currentPerson.nachname}`,
        identitaet: req.currentPerson.churchtools_person_id,
        zeitpunkt,
        ip: req.ip,
        interessenskonflikt: false,
        kommentar: begruendung || null,
      };
      const stampData = {
        jobId: job.id,
        konto: { nummer: konto.kontonummer, bezeichnung: konto.bezeichnung },
        titel,
        verwendungszweck,
        zahlungsdaten,
        kkHinweis: kkHinweisFuerJob(db, job),
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
              rolleLabel: EREIGNIS_LABEL[f.rolle] || f.rolle,
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
        stamped = await stampAndFinalize(pdfBuffer, stampData);
      } catch (err) {
        return renderForm(req, res, 400, result, { interessenskonflikt, begruendung }, [err.message]);
      }

      // TSA I/O stays outside the transaction. On outage, persist the timestamp requirement
      // so export remains blocked until the retry job succeeds, even if TSA is disabled later.
      const tsaUrl = getConfigValue(db, 'zeitstempel_tsa_url');
      let zeitstempelGesetztAm = null;
      let zeitstempelDateiHash = null;
      if (tsaUrl) {
        try {
          stamped = await setZeitstempel(stamped, {
            ...tsaTrustOptions(config),
            url: tsaUrl,
            user: getConfigValue(db, 'zeitstempel_tsa_user') || undefined,
            passwort: getConfigValue(db, 'zeitstempel_tsa_passwort') || undefined,
          });
          zeitstempelGesetztAm = new Date().toISOString();
          zeitstempelDateiHash = createHash('sha256').update(stamped).digest('hex');
        } catch (err) {
          console.error(`Zeitstempel für Job ${job.id} fehlgeschlagen, wird nachgeholt:`, err.message);
        }
      }

      // The old document remains intact until a durable new file can be referenced.
      const tmpPfad = writeFinalDocument(job.pdf_pfad, stamped);

      const effektiverFreigeber2FuerFreigabe = getEffectiveFreigeber2Id(job, konto);
      db.exec('BEGIN');
      try {
        const currentJob = getJobById(db, job.id);
        if (!readFileSync(job.pdf_pfad).equals(pdfBuffer)) throw new Error('Das Quelldokument wurde waehrend der Freigabe veraendert.');
        const currentKonto = getKontoById(db, konto.id);
        req.currentPerson = getPersonById(db, req.currentPerson.churchtools_person_id);
        if (!req.currentPerson?.aktiv || JSON.stringify(currentJob) !== JSON.stringify(job) || JSON.stringify(currentKonto) !== JSON.stringify(konto)) {
          db.exec('ROLLBACK');
          unlinkSync(tmpPfad);
          return res.status(409).render('error', { message: 'Der Vorgang wurde inzwischen geaendert. Bitte erneut pruefen.' });
        }
        if (!loadAuthorized(req, res)) {
          db.exec('ROLLBACK');
          unlinkSync(tmpPfad);
          return;
        }
        createFreigabe(db, {
          jobId: job.id,
          personId: req.currentPerson.churchtools_person_id,
          rolle: 'freigeber2',
          zeitpunkt,
          ip: req.ip,
          interessenskonflikt: false,
          kommentar: begruendung || null,
          eskaliertVon: job.freigabe2_eskaliert_von,
          vertretungFuer:
            !job.freigabe2_eskaliert_an_admin && istAktiveVertretungFuer(db, req.currentPerson.churchtools_person_id, effektiverFreigeber2FuerFreigabe)
              ? effektiverFreigeber2FuerFreigabe
              : null,
        });
        const abgeschlossen = abschliessenFreigabe2(db, job.id);
        if (!abgeschlossen) {
          db.exec('ROLLBACK');
          try { unlinkSync(tmpPfad); } catch { /* best-effort cleanup of the losing attempt's tmp file */ }
          return renderForm(req, res, 409, result, { interessenskonflikt, begruendung }, [
            'Diese Freigabe wurde inzwischen bereits von einem anderen Vorgang abgeschlossen.',
          ]);
        }
        if (zeitstempelGesetztAm) markZeitstempelGesetzt(db, job.id, zeitstempelGesetztAm, zeitstempelDateiHash);
        db.prepare(`UPDATE jobs SET pdf_pfad = ?, freigabe_snapshot = ?, final_datei_hash = ?, zeitstempel_erforderlich = ? WHERE id = ?`).run(
          tmpPfad, JSON.stringify({ version: 1, job, konto, zahlungsdaten, stampData,
            zahlungsdaten_bestaetigung: job.quelle === 'spesen' ? { personId: req.currentPerson.churchtools_person_id, zeitpunkt, stand: req.body.zahlungsdaten_stand } : null }),
          createHash('sha256').update(stamped).digest('hex'), tsaUrl ? 1 : 0, job.id);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        try { unlinkSync(tmpPfad); } catch { /* best-effort cleanup */ }
        throw err;
      }

      if (job.aufgesplittet_von) {
        try {
          await pruefeUndFinalisiereSplitGruppe(db, job.aufgesplittet_von, config);
        } catch (err) {
          // Never let a Splitgruppen-Merge-Fehler die bereits abgeschlossene Freigabe 2 dieses
          // einzelnen Kindes scheitern lassen -- der Nachhol-Cron-Job holt einen fehlgeschlagenen
          // Merge später nach.
          console.error(`Splitgruppen-Prüfung für Elternjob ${job.aufgesplittet_von} fehlgeschlagen:`, err.message);
        }
      }

      res.redirect('/pool');
    } catch (err) {
      next(err);
    }
  });

  return router;
}
