// Freigabe 1 für Spesenpositionen (`/spesen-freigabe1/:id`, docs/spesen-einreichung.md): reine Prüfseite (ohne Konto ändern oder Aufsplitten) mit Freigeben, Ablehnen oder Interessenskonflikt (→ Stellvertretung 1 bzw. Admin-Gruppe).
// Vier-Augen-Prinzip: die einreichende Person und wer einen Konflikt erklärt hat, dürfen nie prüfen; ist die einreichende Person selbst Freigeber 2 des Kontos, geht Freigabe 2 an die Stellvertretung 2 bzw. die Admin-Gruppe.

import { personHasRole } from '../middleware/roles.js';
import { Router } from 'express';
import { feldFehlerAttr } from '../utils/feldFehler.js';
import {
  getJobById,
  eskalierenFreigabe1,
  eskalierenFreigabe1AnAdmin,
  abschliessenFreigabe1,
  eskalierenFreigabe2,
  eskalierenFreigabe2AnAdmin,
  ablehnenJob,
  getEffectiveFreigeber2Id,
} from '../db/jobsRepo.js';
import { getKontoById } from '../db/kontenRepo.js';
import { getSpesenabrechnungById } from '../db/spesenabrechnungenRepo.js';
import { ausschlussGrundFuerEskalationsziel, grundMitAusschluss, adminEskalationsText } from '../services/eskalationsZiel.js';
import { createFreigabe, istKonfliktmelder } from '../db/freigabenRepo.js';
import { getPersonById } from '../db/personenRepo.js';
import { buildSignedDownloadUrl, PDF_PREVIEW_TTL_SECONDS } from '../services/downloadUrl.js';
import { sendNotification, resolveEmpfaenger, FREIGABE2_AN_ADMIN_GRUND } from '../services/notify.js';
import { buildAuditLog } from '../services/auditLog.js';
import { kommentarBereich } from './kommentare.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

export function createSpesenFreigabe1Router({ db, config, mailer, csrfProtection = (req, res, next) => next() }) {
  const router = Router();

  function isSuperadmin(person) {
    return personHasRole(person, config, 'superadmin');
  }

  // Lädt die Position und prüft Berechtigung und Selbstfreigabe-Sperren; bei Mangel 403 gerendert und null geliefert. @returns {{job, konto}|null}
  function loadAuthorized(req, res) {
    const job = getJobById(db, Number(req.params.id));
    if (!job || job.quelle !== 'spesen' || job.status !== 'zugewiesen') {
      res.status(403).render('error', { message: 'Für diese Spesen-Position ist aktuell keine Freigabe 1 möglich.' });
      return null;
    }
    // Muss bedingungslos geprüft werden, vor dem Zweig der Admin-Eskalation unten: Ein Superadmin, der zugleich die einreichende Person dieser Forderung ist, darf hier nie berechtigt werden, nur weil der Zweig der an
    // den Admin eskalierten Fälle bloss die Gruppenzugehörigkeit prüft. Erreichbar so: Einreichende Person ist der eigene Freigeber 1 dieses Kontos → wird bei der Einreichung automatisch an Stellvertretung 1 eskaliert → Stellvertretung 1
    // erklärt ebenfalls einen Konflikt → da freigabe1_eskaliert_von schon gesetzt ist, geht dieser zweite Konflikt direkt an die Admin-Gruppe (SYNC-8), wo die einreichende Person — falls auch Superadmin — isSuperadmin() bestehen und ihre eigene Forderung freigeben würde.
    if (job.eingereicht_von === req.currentPerson.churchtools_person_id) {
      res.status(403).render('error', {
        message: 'Du hast diese Spesen-Position selbst eingereicht und kannst sie nicht selbst freigeben.',
      });
      return null;
    }
    // Wie in der Kontierung (kontierungZugriff.js): wer für diese Position bei Freigabe 1 einen
    // Interessenskonflikt erklärt hat, darf sie nie mehr prüfen -- auch nicht als Superadmin.
    if (istKonfliktmelder(db, job.id, 1, req.currentPerson.churchtools_person_id)) {
      res.status(403).render('error', {
        message: 'Du hast für diese Spesen-Position einen Interessenskonflikt erklärt und kannst sie nicht prüfen.',
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

  // Rendert die Prüfseite (Beleg-Vorschau, Verlauf, Kommentare, Formularwerte und Fehler).
  function renderForm(req, res, status, { job, konto }, values, errors, feldFehler = {}) {
    const spesenabrechnung = getSpesenabrechnungById(db, job.spesenabrechnung_id);
    res.status(status).render('spesen-freigabe1', {
      job,
      konto,
      eingereichtePerson: getPersonById(db, job.eingereicht_von),
      spesenabrechnungTitel: spesenabrechnung?.titel || null,
      previewUrl: buildSignedDownloadUrl(config, job.id, PDF_PREVIEW_TTL_SECONDS),
      values,
      errors,
      feldFehler,
      feldFehlerAttr,
      auditLog: buildAuditLog(db, job.id),
      kommentarBereich: kommentarBereich(db, config, req.currentPerson, job, `/spesen-freigabe1/${job.id}`),
    });
  }

  // GET /spesen-freigabe1/:id – die Prüfseite.
  router.get('/:id', (req, res) => {
    const result = loadAuthorized(req, res);
    if (!result) return;
    renderForm(req, res, 200, result, { interessenskonflikt: '', begruendung: '' }, []);
  });

  // POST /spesen-freigabe1/:id – `aktion=ablehnen` (Begründung Pflicht, Mail an die einreichende Person), Interessenskonflikt (Eskalation) oder Freigeben (weiter zu Freigabe 2).
  router.post('/:id', csrfProtection, asyncHandler(async (req, res, next) => {
    try {
      const result = loadAuthorized(req, res);
      if (!result) return;
      const { job, konto } = result;
      const { aktion, interessenskonflikt, begruendung } = req.body;
      const hatKonflikt = interessenskonflikt === 'ja';
      const values = { interessenskonflikt: interessenskonflikt || '', begruendung: begruendung || '' };

      if ((hatKonflikt || aktion === 'ablehnen') && !begruendung) {
        return renderForm(req, res, 400, result, values, ['Begründung ist bei Interessenskonflikt oder Ablehnung Pflicht.'], { sf1begruendung: 'Begründung ist bei Interessenskonflikt oder Ablehnung Pflicht.' });
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
            typ: 'ablehnung',
            jobId: job.id,
            variablen: {
              empfaengerName: `${einreicher.vorname} ${einreicher.nachname}`,
              jobDateiname: job.dateiname,
              grund: 'Deine Spesen-Position wurde abgelehnt:',
              begruendung,
              link: `${config.publicBaseUrl}/meine-spesen`,
            },
          });
        }
        return res.redirect('/pool');
      }

      if (hatKonflikt) {
        // Stellvertreter 1 ausgeschlossen (gleiche Person, früher erklärter Konflikt, Einreicher) →
        // Admin-Gruppe statt Sackgasse, siehe services/eskalationsZiel.js.
        const sv1Ausschluss = job.freigabe1_eskaliert_von
          ? null
          : ausschlussGrundFuerEskalationsziel(db, job, { stufe: 1, zielId: konto.stellvertreter1_id, meldenderId: req.currentPerson.churchtools_person_id });
        const eskaliertAnAdmin = Boolean(job.freigabe1_eskaliert_von || sv1Ausschluss);
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
            eskalierenFreigabe1AnAdmin(db, job.id, { eskaliertVon: req.currentPerson.churchtools_person_id, grund: grundMitAusschluss(begruendung, sv1Ausschluss) });
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
              typ: 'zuweisung',
              jobId: job.id,
              variablen: {
                empfaengerName: 'Portal-Admin-Team',
                jobDateiname: job.dateiname,
                grund: adminEskalationsText('Eine Spesen-Position', sv1Ausschluss),
                link: `${config.publicBaseUrl}/spesen-freigabe1/${job.id}`,
              },
            });
          }
        } else {
          const stellvertreter1 = getPersonById(db, konto.stellvertreter1_id);
          if (stellvertreter1) {
            await sendNotification(db, mailer, {
              to: stellvertreter1.email,
              typ: 'zuweisung',
              jobId: job.id,
              variablen: {
                empfaengerName: `${stellvertreter1.vorname} ${stellvertreter1.nachname}`,
                jobDateiname: job.dateiname,
                grund: `Eine Spesen-Position wurde dir zur Prüfung übergeben, da ${req.currentPerson.vorname} ${req.currentPerson.nachname} einen Interessenskonflikt erklärt hat.`,
                link: `${config.publicBaseUrl}/spesen-freigabe1/${job.id}`,
              },
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
        // Vier-Augen-Prinzip, zweite Hälfte: Freigabe 1 ist gerade abgeschlossen, aber ist die einreichende Person dieser Spesenposition AUCH der eigene Freigeber 2 dieses Kontos, würde ein unveränderter Fortgang auch für Freigabe 2 zur einreichenden Person
        // zurückführen (getEffectiveFreigeber2Id würde konto.freigeber2_id === job.eingereicht_von wählen). Hier sofort an die Stellvertretung 2 umleiten, atomar mit dem Abschluss von Freigabe 1, statt Freigabe 2 je ohne gültige Person
        // ohne Selbstfreigabe zu erreichen (siehe die Prüfung der einreichenden Person in loadAuthorized von freigabe2.js, die dieselbe Regel zusätzlich absichert).
        if (job.quelle === 'spesen' && konto.freigeber2_id === job.eingereicht_von) {
          // Darf Stellvertreter 2 selbst nicht freigeben (z. B. weil er gerade Freigabe 1 erteilt hat),
          // geht Freigabe 2 direkt an die Admin-Gruppe.
          const sv2Ausschluss = ausschlussGrundFuerEskalationsziel(db, job, { stufe: 2, zielId: konto.stellvertreter2_id, meldenderId: job.eingereicht_von });
          if (sv2Ausschluss) {
            eskalierenFreigabe2AnAdmin(db, job.id, { eskaliertVon: job.eingereicht_von, grund: grundMitAusschluss('Selbsteinreichung durch Freigeber2', sv2Ausschluss) });
          } else {
            eskalierenFreigabe2(db, job.id, { eskaliertVon: job.eingereicht_von, grund: 'Selbsteinreichung durch Freigeber2' });
          }
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      const aktualisierterJob = getJobById(db, job.id);
      if (aktualisierterJob.freigabe2_eskaliert_an_admin) {
        for (const email of resolveEmpfaenger(db, config, 'gruppe:admin')) {
          await sendNotification(db, mailer, {
            to: email,
            typ: 'zuweisung',
            jobId: job.id,
            variablen: {
              empfaengerName: 'Portal-Admin-Team',
              jobDateiname: job.dateiname,
              grund: FREIGABE2_AN_ADMIN_GRUND,
              link: `${config.publicBaseUrl}/freigabe2/${job.id}`,
            },
          });
        }
        return res.redirect('/pool');
      }
      const freigeber2 = getPersonById(db, getEffectiveFreigeber2Id(aktualisierterJob, konto));
      if (freigeber2) {
        await sendNotification(db, mailer, {
          to: freigeber2.email,
          typ: 'zuweisung',
          jobId: job.id,
          variablen: {
            empfaengerName: `${freigeber2.vorname} ${freigeber2.nachname}`,
            jobDateiname: job.dateiname,
            grund: 'Eine Spesen-Position wartet auf deine Freigabe 2.',
            link: `${config.publicBaseUrl}/freigabe2/${job.id}`,
          },
        });
      }
      res.redirect('/pool');
    } catch (err) {
      next(err);
    }
  }));

  return router;
}
