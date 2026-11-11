// Freigabe 2 (`/freigabe2/:id`, docs/rechnungs-workflow.md): die zweite Person (Freigeber 2 des Kontos, deren Stellvertretung, bei Admin-Eskalation ein Superadmin) gibt die Rechnung frei, lehnt ab oder meldet einen Interessenskonflikt.
// Beim Freigeben: Zahlungsdaten bestätigen (Spesen live aus ChurchTools, QR-Rechnungen aus dem Eingangsscan), Freigabe-Snapshot einfrieren, Stempelseite anhängen, RFC3161-Zeitstempel setzen (ausserhalb der Transaktion) und Splitgruppen zusammenführen.
// Vier-Augen-Prinzip und Selbstfreigabe-Sperren: siehe `loadAuthorized`.

import { personHasRole } from '../middleware/roles.js';
import { Router } from 'express';
import { readFileSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { getJobById, eskalierenFreigabe2, eskalierenFreigabe2AnAdmin, abschliessenFreigabe2, ablehnenJob, getEffectiveFreigeber2Id, markZeitstempelGesetzt } from '../db/jobsRepo.js';
import { getKontoById } from '../db/kontenRepo.js';
import { getSpesenabrechnungById } from '../db/spesenabrechnungenRepo.js';
import { ausschlussGrundFuerEskalationsziel, grundMitAusschluss, adminEskalationsText } from '../services/eskalationsZiel.js';
import { createFreigabe, listFreigabenByJob, istKonfliktmelder } from '../db/freigabenRepo.js';
import { getPersonById } from '../db/personenRepo.js';
import { getConfigValue } from '../db/adminConfigRepo.js';
import { stampAndFinalize } from '../services/pdfStamp.js';
import { setZeitstempelMitNachweis } from '../services/zeitstempel.js';
import { speichereTsaNachweis } from '../services/tsaNachweis.js';
import { fetchPersonById, extractCustomFieldValue } from '../services/churchtools.js';
import { validateSpesenPayment, paymentReviewFingerprint, ermittleRechnungsZahlung, zahlungBestaetigungspflichtig, ZAHLUNGSHINWEIS_TEXT } from '../services/paymentApproval.js';
import { buildSignedDownloadUrl, PDF_PREVIEW_TTL_SECONDS } from '../services/downloadUrl.js';
import { sendNotification, sendNotificationMitVertretung, resolveEmpfaenger } from '../services/notify.js';
import { istAktiveVertretungFuer } from '../services/vertretung.js';
import { buildAuditLog, EREIGNIS_LABEL } from '../services/auditLog.js';
import { pruefeUndFinalisiereSplitGruppe } from '../services/splitGruppenExport.js';
import { auffaelligkeitenKasten } from '../services/auffaelligkeitenAnzeige.js';
import { kkHinweisFuerJob } from '../services/kkStempel.js';
import { writeFinalDocument } from '../services/finalDocument.js';
import { tsaTrustOptions } from '../services/tsaTrust.js';
import { kommentarBereich } from './kommentare.js';
import { listeKommentare } from '../services/kommentare.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { feldFehlerAttr } from '../utils/feldFehler.js';

// Stand der Kommentare eines Vorgangs als "<Anzahl>:<letzte id>". Die Seite schreibt ihn beim
// Rendern ins Formular; der POST vergleicht ihn vor dem Stempeln (Kommentar während die Seite offen
// war) und nochmals in der Abschluss-Transaktion (Kommentar während Stempeln/TSA).
function kommentarStandVon(db, jobId) {
  const liste = listeKommentare(db, jobId);
  return `${liste.length}:${liste.at(-1)?.id ?? 0}`;
}
const NEUER_KOMMENTAR = 'Während der Freigabe ist ein neuer Kommentar eingegangen. Bitte lesen und erneut freigeben.';

export function createFreigabe2Router({ db, config, mailer, csrfProtection = (req, res, next) => next() }) {
  const router = Router();

  function isSuperadmin(person) {
    return personHasRole(person, config, 'superadmin');
  }

  // Die Zahlungsdaten für alles ausser Spesen stammen aus dem lokal gespeicherten Eingangsscan (QR-Rechnung) der Rechnung — bei einem Splitkind ist das die ganze Rechnung, in jedem Kind identisch.
  function rechnungsZahlung(job) {
    const parent = job.aufgesplittet_von ? getJobById(db, job.aufgesplittet_von) : null;
    return ermittleRechnungsZahlung(db, job, parent);
  }

  // Zahlungsdaten samt Fingerabdruck (gegen veraltete Formulare) und Hinweistexten für die Bestätigung im Formular.
  function zahlungsReview(job, konto, zahlung, personId) {
    const payment = { art: zahlung.art, daten: zahlung.daten, abgleich: zahlung.abgleich, hinweise: zahlung.hinweise };
    return { ...payment, fingerprint: paymentReviewFingerprint(job, konto, payment, personId), hinweisTexte: zahlung.hinweise.map((h) => ZAHLUNGSHINWEIS_TEXT[h]) };
  }

  // Lädt den Vorgang und prüft die Berechtigung (effektiver Freigeber 2 oder Vertretung; bei Admin-Eskalation Superadmin) samt Sperren gegen Selbstfreigabe; bei Mangel 403 gerendert und null geliefert.
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
    // Vier-Augen-Prinzip: Die Rollenzuweisung des Kontos wird nur beim Bearbeiten durch den Admin geprüft (validateKontoRoles), also als Momentaufnahme der Kontozeile und nicht für diesen konkreten Vorgang. Wird das Konto bearbeitet, während ein Vorgang in freigabe2 liegt
    // — oder hat dieselbe Person Buchhaltung und Portal-Admin —, könnte die Person, die Freigabe 1 schon erteilt hat, sonst auch als aufgelöster Freigeber-2-Genehmiger enden. Deshalb je Vorgang erneut prüfen.
    const freigabe1 = listFreigabenByJob(db, job.id).findLast((f) => f.rolle === 'freigeber1');
    if (freigabe1 && freigabe1.person_id === req.currentPerson.churchtools_person_id) {
      res.status(403).render('error', {
        message: 'Du hast diese Rechnung bereits in Freigabe 1 freigegeben und kannst sie nicht auch in Freigabe 2 freigeben (Vier-Augen-Prinzip).',
      });
      return null;
    }
    // Ein erklärter Interessenskonflikt gehört zur Rechnung: wer ihn auf dieser Stufe erklärt hat,
    // darf Freigabe 2 nie erteilen -- unabhängig davon, wie der Vorgang ihn wieder erreicht
    // (Admin-Umhängen mit anschliessender Ablehnung, Ferienvertretung, Admin-Gruppe).
    if (istKonfliktmelder(db, job.id, 2, req.currentPerson.churchtools_person_id)) {
      res.status(403).render('error', {
        message: 'Du hast für diese Rechnung einen Interessenskonflikt erklärt und kannst Freigabe 2 nicht erteilen.',
      });
      return null;
    }
    // Doppelt gesichert: Der Zweig "Freigeben" in spesenFreigabe1.js leitet eine Spesenposition schon in dem Moment an die Stellvertretung 2 um, in dem Freigabe 1 abgeschlossen ist, sobald die einreichende Person der eigene Freigeber 2 dieses Kontos ist — getEffectiveFreigeber2Id sollte also
    // gar nie auf die einreichende Person zurückführen. Dies hier ist eine direkte, unabhängige Prüfung für den Fall, dass diese Umleitung je umgangen wird (ein Fehler, ein künftiger Codepfad, der einen Spesenvorgang erzeugt, ohne über spesenFreigabe1.js zu laufen) — die zentrale Zusicherung (nie die eigene Forderung freigeben) muss in jedem Fall gelten.
    if (job.quelle === 'spesen' && job.eingereicht_von === req.currentPerson.churchtools_person_id) {
      res.status(403).render('error', {
        message: 'Du hast diese Spesen-Position selbst eingereicht und kannst sie nicht selbst freigeben.',
      });
      return null;
    }
    return { job, konto };
  }

  // Rendert das Freigabeformular (Freigabe 1, Verlauf, Kommentare, Zahlungsprüfung, Vorschau).
  function renderForm(req, res, status, { job, konto }, values, errors, paymentReview = null, feldFehler = {}) {
    const freigaben = listFreigabenByJob(db, job.id);
    const freigabe1 = freigaben.findLast((f) => f.rolle === 'freigeber1');
    if (!freigabe1) {
      return res.status(500).render('error', { message: 'Freigabe 1 fehlt für diesen Job — bitte an den Portal-Admin wenden.' });
    }
    const freigeber1Person = getPersonById(db, freigabe1.person_id);
    const spesenEinreicher = job.quelle === 'spesen' ? getPersonById(db, job.eingereicht_von) : null;
    const spesenabrechnungTitel = job.quelle === 'spesen' ? getSpesenabrechnungById(db, job.spesenabrechnung_id)?.titel || null : null;
    // Die Zahlungsdaten einer Rechnung liegen lokal vor, ihre Prüfung wird also sofort angezeigt; Spesen brauchen die Live-Abfrage bei ChurchTools, die nur der erste POST ausführt.
    let zahlungsart = job.quelle === 'spesen' ? 'spesen' : null;
    if (job.quelle !== 'spesen') {
      const zahlung = rechnungsZahlung(job);
      zahlungsart = zahlung.art || null;
      if (zahlung.fehler) errors = [...errors, zahlung.fehler];
      else if (!paymentReview && zahlungBestaetigungspflichtig(zahlung)) paymentReview = zahlungsReview(job, konto, zahlung, req.currentPerson.churchtools_person_id);
    }
    res.status(status).render('freigabe2', {
      zahlungsart,
      job,
      konto,
      freigabe1,
      freigeber1Person,
      spesenEinreicher,
      spesenabrechnungTitel,
      previewUrl: buildSignedDownloadUrl(config, job.id, PDF_PREVIEW_TTL_SECONDS),
      values,
      errors,
      feldFehler,
      feldFehlerAttr,
      paymentReview,
      auditLog: buildAuditLog(db, job.id),
      kkHinweis: kkHinweisFuerJob(db, job),
      auffaelligkeitenBestaetigt: auffaelligkeitenKasten(db, job.id),
      kommentarBereich: kommentarBereich(db, config, req.currentPerson, job, `/freigabe2/${job.id}`),
      kommentarStand: kommentarStandVon(db, job.id),
    });
  }

  // GET /freigabe2/:id – das Freigabeformular.
  router.get('/:id', (req, res) => {
    const result = loadAuthorized(req, res);
    if (!result) return;
    renderForm(req, res, 200, result, { interessenskonflikt: '', begruendung: '' }, []);
  });

  // POST /freigabe2/:id – Interessenskonflikt (→ Stellvertretung 2 bzw. Admin-Gruppe), `aktion=ablehnen` (→ Überarbeitung, Begründung Pflicht), sonst Freigeben (Zahlungsbestätigung, Stempeln, Zeitstempel, Abschluss).
  router.post('/:id', csrfProtection, asyncHandler(async (req, res, next) => {
    try {
      const result = loadAuthorized(req, res);
      if (!result) return;
      const { job, konto } = result;
      const { aktion, interessenskonflikt, begruendung } = req.body;
      const hatKonflikt = interessenskonflikt === 'ja';

      if (hatKonflikt && !begruendung) {
        return renderForm(req, res, 400, result, { interessenskonflikt, begruendung }, ['Bei einem Interessenskonflikt ist eine Begründung Pflicht.'], null, { f2begruendung: 'Bei einem Interessenskonflikt ist eine Begründung Pflicht.' });
      }

      if (hatKonflikt && aktion === 'ablehnen') {
        return renderForm(req, res, 400, result, { interessenskonflikt, begruendung }, [
          'Bitte entweder einen Interessenskonflikt melden oder die Rechnung ablehnen — nicht beides gleichzeitig.',
        ]);
      }

      if (hatKonflikt) {
        // SYNC-8: Ist job.freigabe2_eskaliert_von hier schon gesetzt, wurde dieser Vorgang bereits einmal eskaliert — und laut loadAuthorized kann die einzige Person, die für einen bereits eskalierten Vorgang bis zu dieser Zeile gelangt, jene eskalierte Stellvertretung 2 der ersten Stufe selbst sein,
        // die nun ebenfalls ihren eigenen Konflikt erklärt. Statt zu blockieren an den Portal-Admin leiten.
        // Eine vom Admin umgeleitete Person, die selbst einen Konflikt erklärt, geht direkt an die
        // Admin-Gruppe: der Admin hat die reguläre Kette (Freigeber2/Stellvertreter2) bewusst
        // übergangen, ein Rücksprung dorthin wäre unklar. eskalierenFreigabe2AnAdmin löscht die
        // Umleitung.
        // Und: Stellvertreter 2 darf selbst nicht freigeben (hat Freigabe 1 erteilt, früher Konflikt
        // erklärt, Spesen eingereicht, ...) → ebenfalls Admin-Gruppe, siehe services/eskalationsZiel.js.
        const sv2Ausschluss = job.freigabe2_eskaliert_von || job.freigabe2_umgeleitet_an
          ? null
          : ausschlussGrundFuerEskalationsziel(db, job, { stufe: 2, zielId: konto.stellvertreter2_id, meldenderId: req.currentPerson.churchtools_person_id });
        const eskaliertAnAdmin = Boolean(job.freigabe2_eskaliert_von) || Boolean(job.freigabe2_umgeleitet_an) || Boolean(sv2Ausschluss);

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
            eskalierenFreigabe2AnAdmin(db, job.id, { eskaliertVon: req.currentPerson.churchtools_person_id, grund: grundMitAusschluss(begruendung, sv2Ausschluss) });
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
                grund: job.freigabe2_umgeleitet_an
                  ? 'Eine Rechnung wurde an die Portal-Admin-Gruppe eskaliert, da die vom Admin bestimmte Person einen Interessenskonflikt erklärt hat.'
                  : adminEskalationsText('Eine Rechnung', sv2Ausschluss),
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
          return renderForm(req, res, 400, result, { interessenskonflikt, begruendung }, ['Bei einer Ablehnung ist eine Begründung Pflicht.'], null, { f2begruendung: 'Bei einer Ablehnung ist eine Begründung Pflicht.' });
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

      // Abschlussprüfung 2: ist seit dem Rendern der Seite ein Kommentar eingegangen, nicht freigeben,
      // sondern die Seite samt neuem Kommentar zeigen. Fehlt das Feld (alter Tab), gilt "0:0".
      const gesehenerStand = typeof req.body.kommentar_stand === 'string' ? req.body.kommentar_stand : '0:0';
      if (gesehenerStand !== kommentarStandVon(db, job.id)) {
        return renderForm(req, res, 409, result, { interessenskonflikt, begruendung }, [NEUER_KOMMENTAR]);
      }

      const freigaben = listFreigabenByJob(db, job.id);
      const freigabe1 = freigaben.findLast((f) => f.rolle === 'freigeber1');
      const freigeber1Person = getPersonById(db, freigabe1.person_id);
      const zeitpunkt = new Date().toISOString();

      // Einfache lokale Datenbankabfragen, anders als die Live-Abfrage bei ChurchTools unten — eine Spesenposition hat kein eigenes Rechnungsdatum, ihr Titel (Spesenabrechnung) und der Verwendungszweck kennzeichnen also das Dokument auf der dauerhaft archivierten Stempelseite.
      const titel = job.quelle === 'spesen' ? getSpesenabrechnungById(db, job.spesenabrechnung_id)?.titel || null : null;
      const verwendungszweck = job.quelle === 'spesen' ? job.beschreibung || null : null;

      let zahlungsdaten = null;
      let zahlung;
      if (job.quelle === 'spesen') {
        if (job.eingereicht_von) {
          try {
            const einreicher = await fetchPersonById(config.churchtools, config.churchtools.syncServiceToken, job.eingereicht_von);
            const ibanRoh = extractCustomFieldValue(einreicher, config.churchtools.customFieldIban);
            zahlungsdaten = validateSpesenPayment(ibanRoh, extractCustomFieldValue(einreicher, config.churchtools.customFieldKontoinhaber));
          } catch (err) {
            console.error(`Zahlungsdaten-Abruf für Job ${job.id} fehlgeschlagen; Freigabe gesperrt.`);
          }
        }
        if (!zahlungsdaten) {
          return renderForm(req, res, 400, result, { interessenskonflikt, begruendung }, ['Freigabe gesperrt: Eine gültige Schweizer IBAN und der Kontoinhaber müssen in ChurchTools hinterlegt und abrufbar sein.']);
        }
        zahlung = { art: 'spesen', daten: zahlungsdaten, abgleich: null, hinweise: [] };
      } else {
        zahlung = rechnungsZahlung(job);
        if (zahlung.fehler) return renderForm(req, res, 400, result, { interessenskonflikt, begruendung }, []);
      }
      const zahlungPflichtig = zahlungBestaetigungspflichtig(zahlung);
      let zahlungsStand = null;
      if (zahlungPflichtig) {
        const review = zahlungsReview(job, konto, zahlung, req.currentPerson.churchtools_person_id);
        const bestaetigt = req.body.zahlungsdaten_bestaetigt === 'ja' && req.body.zahlungsdaten_stand === review.fingerprint &&
          (zahlung.hinweise.length === 0 || req.body.zahlungshinweise_bestaetigt === 'ja');
        if (!bestaetigt) {
          const changed = Boolean(req.body.zahlungsdaten_stand);
          const standGeaendert = changed && req.body.zahlungsdaten_stand !== review.fingerprint;
          const text = standGeaendert ? 'Der Zahlungs- oder Vorgangsstand wurde geändert. Bitte erneut prüfen und bestätigen.' : 'Bitte die Zahlungsdaten prüfen und bestätigen.';
          const feld = standGeaendert ? null : (req.body.zahlungsdaten_bestaetigt !== 'ja' ? 'zahlungsdatenBestaetigt' : (zahlung.hinweise.length > 0 ? 'zahlungshinweiseBestaetigt' : null));
          return renderForm(req, res, changed ? 409 : 400, result, { interessenskonflikt, begruendung },
            [text], review, feld ? { [feld]: text } : {});
        }
        zahlungsStand = review.fingerprint;
      }
      // Auf der archivierten Stempelseite gedruckt: Spesen behalten ihre bestehende Form, eine QR-Rechnung zeigt den bestätigten Empfänger, die IBAN und die Referenz.
      const stampZahlungsdaten = zahlung.art === 'spesen'
        ? zahlungsdaten
        : zahlung.daten ? { empfaenger: zahlung.daten.empfaenger, iban: zahlung.daten.iban, referenz: zahlung.daten.referenz } : null;

      const freigeber2Eintrag = {
        name: `${req.currentPerson.vorname} ${req.currentPerson.nachname}`,
        identitaet: req.currentPerson.churchtools_person_id,
        zeitpunkt,
        ip: req.ip,
        interessenskonflikt: false,
        kommentar: begruendung || null,
      };
      // Stand der gestempelten Kommentare: geht während Stempeln/TSA ein neuer ein, wird nicht
      // abgeschlossen (sonst fehlte er auf dem archivierten PDF und wäre ungelesen).
      const stampKommentare = listeKommentare(db, job.id);
      const stampKommentarStand = `${stampKommentare.length}:${stampKommentare.at(-1)?.id ?? 0}`;
      const stampData = {
        // Test-Instanz: Marke "TESTMODUS – keine echte Freigabe" auf der Stempelseite.
        ...(config.testmodus ? { testmodus: true } : {}),
        jobId: job.id,
        konto: { nummer: konto.kontonummer, bezeichnung: konto.bezeichnung },
        titel,
        verwendungszweck,
        zahlungsdaten: stampZahlungsdaten,
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
        // `freigaben` wurde geladen, bevor die eigene Freigabe 2 dieser Anfrage gespeichert ist (dieses Einfügen geschieht später, atomar zusammen mit abschliessenFreigabe2). Ohne sie hier anzuhängen, fehlte auf der Verlaufsseite des fertig gestempelten PDFs genau die Freigabe, die den Vorgang abschloss.
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
        // Alle Kommentare des Vorgangs (chronologisch) im Abschnitt "Rückfragen und Kommentare";
        // nach Freigabe 2 sind keine neuen mehr möglich, der Stand auf dem PDF ist also vollständig.
        kommentare: stampKommentare.map((k) => ({ zeitpunkt: k.erstellt_am, verfasser: k.verfasser_name, text: k.text })),
      };

      const pdfBuffer = readFileSync(job.pdf_pfad);
      let stamped;
      try {
        stamped = await stampAndFinalize(pdfBuffer, stampData);
      } catch (err) {
        return renderForm(req, res, 400, result, { interessenskonflikt, begruendung }, [err.message]);
      }

      // TSA-I/O bleibt ausserhalb der Transaktion. Bei einem Ausfall wird die Zeitstempelpflicht gespeichert, damit der Export gesperrt bleibt, bis der Wiederholungsjob erfolgreich war, auch wenn die TSA später abgeschaltet wird.
      const tsaUrl = getConfigValue(db, 'zeitstempel_tsa_url');
      let zeitstempelGesetztAm = null;
      let zeitstempelDateiHash = null;
      let tsaNachweis = null;
      if (tsaUrl) {
        try {
          ({ stamped, nachweis: tsaNachweis } = await setZeitstempelMitNachweis(stamped, {
            ...tsaTrustOptions(config),
            url: tsaUrl,
            user: getConfigValue(db, 'zeitstempel_tsa_user') || undefined,
            passwort: getConfigValue(db, 'zeitstempel_tsa_passwort') || undefined,
          }));
          zeitstempelGesetztAm = new Date().toISOString();
          zeitstempelDateiHash = createHash('sha256').update(stamped).digest('hex');
        } catch (err) {
          console.error(`Zeitstempel für Job ${job.id} fehlgeschlagen, wird nachgeholt:`, err.message);
        }
      }

      // Das alte Dokument bleibt unverändert, bis eine dauerhafte neue Datei referenziert werden kann.
      const tmpPfad = writeFinalDocument(job.pdf_pfad, stamped);

      const effektiverFreigeber2FuerFreigabe = getEffectiveFreigeber2Id(job, konto);
      db.exec('BEGIN');
      try {
        const currentJob = getJobById(db, job.id);
        if (!readFileSync(job.pdf_pfad).equals(pdfBuffer)) throw new Error('Das Quelldokument wurde während der Freigabe verändert.');
        const currentKonto = getKontoById(db, konto.id);
        req.currentPerson = getPersonById(db, req.currentPerson.churchtools_person_id);
        if (!req.currentPerson?.aktiv || JSON.stringify(currentJob) !== JSON.stringify(job) || JSON.stringify(currentKonto) !== JSON.stringify(konto)) {
          db.exec('ROLLBACK');
          unlinkSync(tmpPfad);
          return res.status(409).render('error', { message: 'Der Vorgang wurde inzwischen geändert. Bitte erneut prüfen.' });
        }
        if (!loadAuthorized(req, res)) {
          db.exec('ROLLBACK');
          unlinkSync(tmpPfad);
          return;
        }
        if (job.quelle !== 'spesen' && JSON.stringify(rechnungsZahlung(currentJob)) !== JSON.stringify(zahlung)) {
          db.exec('ROLLBACK');
          unlinkSync(tmpPfad);
          return res.status(409).render('error', { message: 'Die Zahlungsdaten oder deren Prüfung haben sich inzwischen geändert. Bitte erneut prüfen.' });
        }
        if (kommentarStandVon(db, job.id) !== stampKommentarStand) {
          db.exec('ROLLBACK');
          unlinkSync(tmpPfad);
          return renderForm(req, res, 409, result, { interessenskonflikt, begruendung }, [NEUER_KOMMENTAR], zahlungPflichtig ? zahlungsReview(job, konto, zahlung, req.currentPerson.churchtools_person_id) : null);
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
          try { unlinkSync(tmpPfad); } catch { /* Best-Effort-Aufräumen der tmp-Datei des unterlegenen Versuchs */ }
          return renderForm(req, res, 409, result, { interessenskonflikt, begruendung }, [
            'Diese Freigabe wurde inzwischen bereits von einem anderen Vorgang abgeschlossen.',
          ]);
        }
        if (zeitstempelGesetztAm) {
          markZeitstempelGesetzt(db, job.id, zeitstempelGesetztAm, zeitstempelDateiHash);
          speichereTsaNachweis(db, { jobId: job.id, bezug: 'einzel', dokumentSha256: zeitstempelDateiHash, nachweis: tsaNachweis });
        }
        db.prepare(`UPDATE jobs SET pdf_pfad = ?, freigabe_snapshot = ?, final_datei_hash = ?, zeitstempel_erforderlich = ? WHERE id = ?`).run(
          tmpPfad, JSON.stringify({ version: 2, job, konto, zahlungsdaten, stampData,
            zahlungsdaten_bestaetigung: job.quelle === 'spesen' ? { personId: req.currentPerson.churchtools_person_id, zeitpunkt, stand: zahlungsStand } : null,
            zahlung: { ...zahlung, bestaetigung: zahlungPflichtig ? { person_id: req.currentPerson.churchtools_person_id, zeitpunkt, stand: zahlungsStand } : null } }),
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
  }));

  return router;
}
