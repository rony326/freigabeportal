import { Router } from 'express';
import { auffaelligkeitenKasten } from '../services/auffaelligkeitenAnzeige.js';
import { personHasRole } from '../middleware/roles.js';
import { personHasPermission } from '../middleware/permissions.js';
import { meldeZugriffVerweigert } from '../services/zugriffsAudit.js';
import multer from 'multer';
import { mitAuditKontext } from '../services/auditContext.js';
import { detectBelegMimetype, countBelegSeiten } from '../services/belegAnhaengen.js';
import { ausschlussGrundFuerEskalationsziel, grundMitAusschluss, adminEskalationsText } from '../services/eskalationsZiel.js';
import {
  getJobById,
  setKontierung,
  updateKontierungMetadaten,
  ablehnenJob,
  eskalierenFreigabe1,
  eskalierenFreigabe1AnAdmin,
  abschliessenFreigabe1,
  weiterleitenAnEchtenFreigeber1,
  releaseJob,
  getEffectiveFreigeber2Id,
  markJobAufgesplittet,
  setJobBetrag,
  setJobKreditor,
  setJobTyp,
  addBelegSeiten,
  findJobsByKreditorUndRechnungsnummer,
  findMoeglicheDoppelrechnungen,
  DOPPELRECHNUNG_FENSTER_TAGE,
  sendJobBackToGroup,
  hebeKkMarkierungAuf,
} from '../db/jobsRepo.js';
import { getKontoById, listKonten, kontoErlaubtFuerTyp } from '../db/kontenRepo.js';
import { listKreditorenWaehlbar, getKreditorById, istKreditorVollstaendig, ZAHLUNGSARTEN, ZAHLUNGSART_LABEL } from '../db/kreditorenRepo.js';
import { findKreditorIbanByIban } from '../db/kreditorIbanRepo.js';
import { brauchtManuelleIbanPruefung, ibanEndungPasst, ermittleBefunde, befundeHash } from '../services/betrugspruefung.js';
import { speichereBestaetigung } from '../db/auffaelligkeitenRepo.js';
import { sendeAuffaelligkeitenWarnung, bestaetigungsKommentar } from '../services/auffaelligkeitenWarnung.js';
import { normalizeIban } from '../services/ibanUtils.js';
import { pruefeNeuenKreditor, legeKreditorAn } from '../services/kreditorAnlegen.js';
import { kreditorIdAusEingabe, kreditorNameVariablen, KreditorFeldKonflikt } from '../services/kreditorFelder.js';
import { getKreditkarteById, listKreditkarten } from '../db/kreditkartenRepo.js';
import { createFreigabe } from '../db/freigabenRepo.js';
import { istRapportModulAktiv, listRapportEmpfaengerKandidaten, markiereRapport, hebeRapportAuf } from '../services/rapporte.js';
import { buildSignedDownloadUrl, PDF_PREVIEW_TTL_SECONDS } from '../services/downloadUrl.js';
import { getPersonById } from '../db/personenRepo.js';
import { sendNotification, sendNotificationMitVertretung, resolveEmpfaenger, FREIGABE2_AN_ADMIN_GRUND } from '../services/notify.js';
import { istAktiveVertretungFuer } from '../services/vertretung.js';
import { buildAuditLog } from '../services/auditLog.js';
import { getConfigValue } from '../db/adminConfigRepo.js';
import { ladeKontierbarenJob, ermittleStriktesWeiterleitungsZiel, ladeKontenFuerJob as ladeKontenFuerJobService } from '../services/kontierungZugriff.js';
import { markiereAlsKkAbrechnung } from '../services/kkMarkierung.js';
import { kkHinweisFuerJob } from '../services/kkStempel.js';
import { kommentarBereich } from './kommentare.js';
import {
  POSITION_PATTERN,
  mergeBelegFuerJob,
  pruefeIbanAbgleich,
  bereiteTeilDateienVor,
  erzeugeTeilJobs,
  benachrichtigeNachAufsplitten,
  alleKindIds,
} from '../services/aufsplitten.js';
import { asyncCallback, asyncHandler } from '../middleware/asyncHandler.js';
import { neueFehler, feldFehlerAttr } from '../utils/feldFehler.js';

const BETRAG_PATTERN = /^\d+([.,]\d{1,2})?$/;
const ZAHLUNGSZIEL_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const IBAN_ENDUNG_PATTERN = /^[A-Z0-9]{4}$/;
const IBAN_ENDUNG_FEHLER = 'Bitte gib die letzten 4 Zeichen der IBAN auf der Rechnung ein.';
const PRUEF_BEMERKUNG_MAX = 500;
const MAX_BELEG_SIZE = 20 * 1024 * 1024;
// Aufsplitten sends one optional beleg file per Teil row (teilBeleg_<i>) via uploadBeleg.any(),
// which has no field-name allowlist — without a files cap, a request forging many parts could
// force up to fileSize each into memory. No real form has anywhere near this many Teile.
const MAX_BELEG_FILES = 25;

const uploadBeleg = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BELEG_SIZE, files: MAX_BELEG_FILES },
});

function buildQrInfo(db, job) {
  if (!job.qr_erkannt_am) return null;
  const ibanMapping = job.qr_iban ? findKreditorIbanByIban(db, job.qr_iban) : null;
  const vorschlagKreditor = ibanMapping ? getKreditorById(db, ibanMapping.kreditor_id) : null;
  const kreditorFuerAbgleich = job.kreditor_id ? getKreditorById(db, job.kreditor_id) : vorschlagKreditor;
  const abgleich = job.qr_iban && kreditorFuerAbgleich ? pruefeIbanAbgleich(db, kreditorFuerAbgleich.id, job.qr_iban) : null;
  const konfliktMitZugewiesenemKreditor = Boolean(vorschlagKreditor) && Boolean(job.kreditor_id) && vorschlagKreditor.id !== job.kreditor_id;
  return {
    iban: job.qr_iban,
    referenz: job.qr_referenz,
    betrag: job.qr_betrag,
    waehrung: job.qr_waehrung,
    creditorName: job.qr_creditor_name,
    vorschlagKreditor,
    // Only meaningful (and only resolved) when there's actually a conflict to name — kreditorFuerAbgleich
    // already IS the currently-assigned kreditor in that case, since job.kreditor_id is truthy whenever
    // konfliktMitZugewiesenemKreditor is true.
    zugewiesenerKreditor: konfliktMitZugewiesenemKreditor ? kreditorFuerAbgleich : null,
    kreditorFuerAbgleich,
    konfliktMitZugewiesenemKreditor,
    abgleich,
  };
}

export function createKontierungRouter({ db, config, mailer, csrfProtection = (req, res, next) => next() }) {
  const router = Router();

  const LIEFERANT_NUR_ADMIN_HINWEIS = 'Neue Lieferanten legt die Administration an.';
  const darfLieferantenAnlegen = (person) => personHasPermission(db, config, person, 'kreditoren_verwalten');

  const lieferantAnsicht = (req) => ({ darfLieferantAnlegen: darfLieferantenAnlegen(req.currentPerson), ZAHLUNGSARTEN, ZAHLUNGSART_LABEL });

  const loadAuthorizedJob = (req, res, optionen) => ladeKontierbarenJob(db, config, req, res, optionen);
  const ladeKontenFuerJob = (req, job) => ladeKontenFuerJobService(db, req, job);

  function sperreKkAbrechnung(job, res) {
    if (!job.kreditkarte_id) return false;
    res.status(409).render('error', { message: 'Diese Abrechnung ist einer Kreditkarte zugeordnet und wird über den Abgleich bearbeitet.' });
    return true;
  }

  // Nur bei aktivem Modul bietet das Formular «Nur zur Kenntnis (Rapport)» an.
  function rapportAnsicht(job) {
    const aktiv = istRapportModulAktiv(db);
    return { rapportModulAktiv: aktiv, rapportEmpfaengerKandidaten: aktiv ? listRapportEmpfaengerKandidaten(db) : [] };
  }

  router.get('/:id', (req, res) => {
    const job = loadAuthorizedJob(req, res);
    if (!job) return;
    if (job.kreditkarte_id) return res.redirect(`/kontierung/${job.id}/kk-abgleich`);
    const konten = ladeKontenFuerJob(req, job);
    const qrInfo = buildQrInfo(db, job);
    res.render('kontierung', {
      job,
      konten,
      alleKonten: listKonten(db),
      kreditoren: listKreditorenWaehlbar(db),
      ...lieferantAnsicht(req),
      kkKarten: getConfigValue(db, 'modul_kreditkarten_aktiv') === '1' ? listKreditkarten(db) : [],
      ...rapportAnsicht(job),
      previewUrl: buildSignedDownloadUrl(config, job.id, PDF_PREVIEW_TTL_SECONDS),
      kkHinweis: kkHinweisFuerJob(db, job),
      auffaelligkeitenBestaetigt: auffaelligkeitenKasten(db, job.id),
      values: {
        kontoId: job.konto_id ? String(job.konto_id) : '',
        typ: job.typ || 'rechnung',
        interessenskonflikt: '',
        begruendung: '',
        absender: job.absender || '',
        betrag: job.betrag || (qrInfo ? qrInfo.betrag || '' : ''),
        zahlungsziel: job.zahlungsziel || '',
        rechnungsnummer: job.rechnungsnummer || '',
        kreditorId: job.kreditor_id ? String(job.kreditor_id) : (qrInfo && qrInfo.vorschlagKreditor ? String(qrInfo.vorschlagKreditor.id) : ''),
      },
      qrInfo,
      errors: [],
      feldFehler: {},
      feldFehlerAttr,
      auditLog: buildAuditLog(db, job.id),
      kommentarBereich: kommentarBereich(db, config, req.currentPerson, job, `/kontierung/${job.id}`),
    });
  });

  // Must be registered before the generic /:id routes below — otherwise POST
  // /kontierung/lieferanten would first match /:id (with id="lieferanten", a NaN Number()) and
  // 404/403 before ever reaching this handler. Neue Lieferanten (mit Pflicht-IBAN) legt nur an,
  // wer Lieferanten verwalten darf; dieselbe Prüfung wie in POST /admin/kreditoren.
  router.post('/lieferanten', csrfProtection, (req, res) => {
    const person = req.currentPerson;
    if (!darfLieferantenAnlegen(person)) {
      meldeZugriffVerweigert(req, { grund: 'fehlendes_recht', status: 403, recht: 'kreditoren_verwalten' });
      return res.status(403).json({ error: LIEFERANT_NUR_ADMIN_HINWEIS });
    }
    const { name, kontoId, iban } = req.body;
    const zahlungsart = req.body.zahlungsart;
    const { errors, normalizedIban } = pruefeNeuenKreditor(db, { name, zahlungsart, iban, kontoId });
    if (errors.length > 0) {
      return res.status(400).json({ error: errors.join(' ') });
    }
    const id = legeKreditorAn(db, { name, kontoId, zahlungsart, normalizedIban });
    res.status(201).json({ id, name: name.trim() });
  });

  router.post('/:id', (req, res, next) => {
    mitAuditKontext(uploadBeleg.single('beleg'))(req, res, asyncCallback(next, async (uploadErr) => {
    // csrfProtection runs after multer parses the multipart body (the _csrf field included) —
    // any earlier and req.body would still be empty, rejecting every legitimate submission.
    csrfProtection(req, res, asyncCallback(next, async (csrfErr) => {
    if (csrfErr) return next(csrfErr);
    try {
      const job = loadAuthorizedJob(req, res);
      if (!job) return;
      if (sperreKkAbrechnung(job, res)) return;
      // Vor jeder Kontierungsvalidierung: ein Rapport hat weder Konto noch Betrag, die Felder des
      // Formulars werden hier bewusst nicht gelesen.
      if (req.body.aktion === 'rapport') {
        const empfaengerIds = [].concat(req.body.empfaengerIds ?? []).map(String);
        const bemerkung = req.body.bemerkung || '';
        const ergebnis = await markiereRapport(db, config, mailer, { job, person: req.currentPerson, empfaengerIds, bemerkung, ip: req.ip });
        if (ergebnis.ok) return res.redirect('/pool');
        if (ergebnis.status !== 400) return res.status(ergebnis.status).render('error', { message: ergebnis.fehler });
        return res.status(400).render('kontierung', {
          job,
          konten: ladeKontenFuerJob(req, job),
          alleKonten: listKonten(db),
          kreditoren: listKreditorenWaehlbar(db),
          ...lieferantAnsicht(req),
          previewUrl: buildSignedDownloadUrl(config, job.id, PDF_PREVIEW_TTL_SECONDS),
          kkHinweis: kkHinweisFuerJob(db, job),
          kkKarten: getConfigValue(db, 'modul_kreditkarten_aktiv') === '1' ? listKreditkarten(db) : [],
          ...rapportAnsicht(job),
          values: { kontoId: '', typ: 'rapport', interessenskonflikt: '', begruendung: '', absender: job.absender || '', betrag: '', zahlungsziel: '', rechnungsnummer: '', kreditorId: '', rapportEmpfaengerIds: empfaengerIds, rapportBemerkung: bemerkung },
          qrInfo: buildQrInfo(db, job),
          errors: [ergebnis.fehler],
          auditLog: buildAuditLog(db, job.id),
          auffaelligkeitenBestaetigt: auffaelligkeitenKasten(db, job.id),
        });
      }
      const konten = ladeKontenFuerJob(req, job);
      const kreditoren = listKreditorenWaehlbar(db);
      const qrInfo = buildQrInfo(db, job);
      let kreditorId;
      try {
        // Uebergangsweise auch das alte Feld debitorId aus vor dem Deployment geladenen Formularen.
        kreditorId = kreditorIdAusEingabe(req.body) ?? undefined;
      } catch (err) {
        if (err instanceof KreditorFeldKonflikt) return res.status(400).render('error', { message: err.message });
        throw err;
      }
      const { kontoId, interessenskonflikt, begruendung, absender, betrag, zahlungsziel, rechnungsnummer, aktion, typ } = req.body;
      const jobTyp = typ === 'gutschrift' ? 'gutschrift' : 'rechnung';
      const ibanEndung = normalizeIban(typeof req.body.ibanEndung === 'string' ? req.body.ibanEndung : '');
      const pruefBemerkung = (typeof req.body.pruefBemerkung === 'string' ? req.body.pruefBemerkung.trim() : '').slice(0, PRUEF_BEMERKUNG_MAX);
      const values = { kontoId, interessenskonflikt, begruendung, absender, betrag, zahlungsziel, rechnungsnummer, kreditorId, typ: jobTyp, ibanEndung, pruefBemerkung };

      const renderSeite = (status, { fehler = neueFehler(), auffaelligkeiten = null } = {}) =>
        res.status(status).render('kontierung', {
          job,
          konten,
          alleKonten: listKonten(db),
          kreditoren,
          ...lieferantAnsicht(req),
          previewUrl: buildSignedDownloadUrl(config, job.id, PDF_PREVIEW_TTL_SECONDS),
          kkHinweis: kkHinweisFuerJob(db, job),
          values,
          qrInfo,
          kkKarten: getConfigValue(db, 'modul_kreditkarten_aktiv') === '1' ? listKreditkarten(db) : [],
          ...rapportAnsicht(job),
          errors: fehler.liste,
          feldFehler: fehler.proFeld,
          feldFehlerAttr,
          auditLog: buildAuditLog(db, job.id),
          auffaelligkeiten,
          auffaelligkeitenBestaetigt: auffaelligkeitenKasten(db, job.id),
        });

      // `messages`: Text oder neueFehler()-Sammler; `feld` ordnet einen einzelnen Text einem Feld zu.
      const renderFehler = (messages, status = 400, feld = null) => {
        const fehler = typeof messages === 'object' && messages && Array.isArray(messages.liste) ? messages : neueFehler();
        if (fehler !== messages) fehler.add(feld, messages);
        return renderSeite(status, { fehler });
      };

      if (uploadErr) {
        return renderFehler(uploadErr.code === 'LIMIT_FILE_SIZE' ? 'Der Beleg darf höchstens 20 MB gross sein.' : 'Fehler beim Datei-Upload.');
      }
      // Applies regardless of aktion (kontieren or ablehnen) — a Beleg attached alongside a
      // rejection is still merged, since the original PDF (with the Beleg now part of it) is
      // what gets reworked and resubmitted afterwards.
      let belegMimetype = null;
      if (req.file) {
        belegMimetype = detectBelegMimetype(req.file.buffer);
        if (!belegMimetype || belegMimetype !== req.file.mimetype) {
          return renderFehler('Beleg muss eine PDF-, PNG- oder JPEG-Datei sein.');
        }
      }

      if (aktion === 'ablehnen') {
        if (!begruendung) {
          return renderFehler('Bei einer Ablehnung ist eine Begründung Pflicht.', 400, 'begruendung');
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
              vertretungFuer: !job.freigabe1_eskaliert_an_admin && istAktiveVertretungFuer(db, req.currentPerson.churchtools_person_id, job.zugewiesen_an) ? job.zugewiesen_an : null,
            });
          }
          db.exec('COMMIT');
        } catch (err) {
          db.exec('ROLLBACK');
          throw err;
        }

        if (!abgelehnt) {
          return renderFehler('Diese Rechnung wurde inzwischen bereits von einem anderen Vorgang bearbeitet.', 409);
        }

        // beleg_seitenzahl mitzuführen ist hier genauso Pflicht wie beim Aufsplitten: auch ein
        // Splitkind (aufgesplittet_von gesetzt) landet auf diesem Pfad, wenn seine Zeile abgelehnt
        // und überarbeitet wird. Ohne die Fortschreibung wüsste der spätere Gruppen-Merge nichts
        // von diesen Belegseiten und liesse sie kommentarlos aus dem Archivdokument weg.
        // Bewusst nicht auf Splitkinder eingeschränkt -- bei einem gewöhnlichen Job liest diese
        // Spalte schlicht niemand.
        if (req.file) {
          // Merge first, count second: if mergeBelegFuerJob throws (e.g. a truncated-but-
          // well-signed image that only fails inside embedPng), beleg_seitenzahl must not have
          // already been incremented for pages that were never actually written -- an inflated
          // count later makes haengeBelegSeitenAn's slice over-reach into the child's own
          // Freigabe-2 Stempelseite, corrupting the archival document silently.
          await mergeBelegFuerJob(job.pdf_pfad, req.file, belegMimetype);
          addBelegSeiten(db, job.id, await countBelegSeiten(req.file.buffer, belegMimetype));
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
        }

        return res.redirect('/pool');
      }

      const errors = neueFehler();

      const konto = konten.find((k) => String(k.id) === kontoId);
      if (!konto) {
        errors.add('kontoId', 'Bitte ein gültiges Konto aus der Liste auswählen.');
      } else if (!kontoErlaubtFuerTyp(konto, jobTyp)) {
        errors.add('kontoId', `Dieses Konto kann nicht für ${jobTyp === 'gutschrift' ? 'Gutschriften' : 'Rechnungen'} verwendet werden.`);
      }
      if (!absender) {
        errors.add('absender', 'Bitte einen Absender angeben.');
      }
      const gefundenerKreditor = kreditorId ? getKreditorById(db, kreditorId) : null;
      // Deaktivierte Lieferanten stehen nicht in der Auswahl (listKreditorenWaehlbar) und werden auch
      // per manipuliertem Formular nicht angenommen.
      const kreditor = gefundenerKreditor && gefundenerKreditor.aktiv ? gefundenerKreditor : null;
      if (!kreditor) {
        errors.add('kreditorId', 'Bitte einen gültigen Lieferanten aus der Liste auswählen.');
      } else if (!istKreditorVollstaendig(db, kreditor)) {
        errors.add('kreditorId', 'Dieser Lieferant hat noch keine IBAN. Bitte melde dich bei der Administration.');
      }
      // Ohne QR-Code kann die IBAN nicht automatisch geprüft werden: die kontierende Person liest die
      // letzten 4 Zeichen von der Rechnung ab. Die hinterlegte IBAN wird nie angezeigt.
      const ibanManuellNoetig = Boolean(kreditor) && brauchtManuelleIbanPruefung(job, kreditor, jobTyp);
      if (ibanManuellNoetig && !IBAN_ENDUNG_PATTERN.test(ibanEndung)) {
        errors.add('ibanEndung', IBAN_ENDUNG_FEHLER);
      }
      if (!rechnungsnummer) {
        errors.add('rechnungsnummer', 'Bitte eine Rechnungsnummer angeben.');
      }
      const hatKonflikt = interessenskonflikt === 'ja';
      if (hatKonflikt && !begruendung) {
        errors.add('begruendung', 'Bei einem Interessenskonflikt ist eine Begründung Pflicht.');
      }
      if (!betrag) {
        errors.add('betrag', 'Bitte einen Betrag angeben.');
      } else if (!BETRAG_PATTERN.test(betrag)) {
        errors.add('betrag', 'Betrag muss eine gültige Zahl sein (z.B. 123.45).');
      }
      // Eine Gutschrift hat kein Fälligkeitsdatum im eigentlichen Sinn — nur bei einer Rechnung
      // ist das Zahlungsziel Pflicht; ein trotzdem mitgegebener Wert wird aber weiterhin geprüft.
      if (!zahlungsziel) {
        if (jobTyp === 'rechnung') {
          errors.add('zahlungsziel', 'Bitte ein Zahlungsziel angeben.');
        }
      } else if (!ZAHLUNGSZIEL_PATTERN.test(zahlungsziel) || Number.isNaN(new Date(zahlungsziel).getTime())) {
        errors.add('zahlungsziel', 'Zahlungsziel ist kein gültiges Datum.');
      }

      if (errors.liste.length > 0) {
        return renderFehler(errors);
      }

      // SYNC-8: a conflict-driven escalation has no distinct named person to hand off to in two
      // cases — this job was already escalated once (so the only person who could even reach
      // this line, per loadAuthorizedJob, is the previously-escalated Stellvertreter1, and they
      // ALSO have a conflict), or the chosen Konto's stellvertreter1 IS the current person
      // (escalating would target themselves). Both route to the Portal-Admin group instead of
      // blocking with the old "go back to pool / contact admin" dead end.
      // Zusätzlich: Stellvertreter 1 darf den Vorgang aus einem anderen Grund nicht bearbeiten
      // (früher erklärter Konflikt, Spesen-Einreicher, ...) — dann ebenfalls an die Admin-Gruppe,
      // siehe services/eskalationsZiel.js.
      const sv1Ausschluss = hatKonflikt && !job.freigabe1_eskaliert_von
        ? ausschlussGrundFuerEskalationsziel(db, job, { stufe: 1, zielId: konto.stellvertreter1_id, meldenderId: req.currentPerson.churchtools_person_id })
        : null;
      const eskaliertAnAdmin = hatKonflikt && Boolean(job.freigabe1_eskaliert_von || sv1Ausschluss);
      const strikteFreigeber1Pruefung = getConfigValue(db, 'kontierung_strikte_freigeber1_pruefung') === '1';
      const istEchterFreigeber1 =
        konto.freigeber1_id === req.currentPerson.churchtools_person_id ||
        istAktiveVertretungFuer(db, req.currentPerson.churchtools_person_id, konto.freigeber1_id) ||
        (Boolean(job.freigabe1_eskaliert_von) && konto.stellvertreter1_id === req.currentPerson.churchtools_person_id);
      const wirdWeitergeleitet = !hatKonflikt && !eskaliertAnAdmin && strikteFreigeber1Pruefung && !job.freigabe1_eskaliert_an_admin && !istEchterFreigeber1;

      const weiterleitungsZiel = wirdWeitergeleitet
        ? ermittleStriktesWeiterleitungsZiel(db, job, konto, req.currentPerson.churchtools_person_id)
        : null;

      // Prüf-Popup (Spec B6): gilt in allen Kontieren-Zweigen. Ohne Bestätigung der aktuell
      // berechneten Befunde wird nichts gespeichert und keine Mail verschickt. Ändert sich ein
      // Befund (anderer Betrag, neue Rechnung im Zeitfenster …), passt der Hash nicht mehr und das
      // Popup erscheint erneut.
      const befunde = ermittleBefunde(db, { job, kreditor, betrag, typ: jobTyp, ibanEndung: ibanManuellNoetig ? ibanEndung : null, rechnungsnummer });
      const hash = befunde.length > 0 ? befundeHash(befunde) : null;
      if (hash && req.body.auffaelligkeitenHash !== hash) {
        protokolliereAngezeigteAuffaelligkeiten(job.id, req.currentPerson, befunde);
        return renderSeite(200, {
          auffaelligkeiten: {
            befunde,
            hash,
            zeigeTelefonHinweis: befunde.some((b) => b.code.startsWith('iban')),
            // Ein Datei-Feld lässt sich nicht vorbefüllen: der Beleg wird im Modal nochmals gewählt.
            belegFelder: req.file
              ? [{ id: 'auffaelligkeiten-beleg', name: 'beleg', label: 'Einen angehängten Beleg hast du noch nicht gespeichert. Bitte wähle ihn hier nochmals aus, bevor du speicherst.' }]
              : [],
          },
        });
      }

      db.exec('BEGIN');
      try {
        setKontierung(db, job.id, konto.id);
        updateKontierungMetadaten(db, job.id, {
          absender,
          betrag: betrag ? betrag.replace(',', '.') : null,
          zahlungsziel,
          rechnungsnummer,
          lieferant: kreditor ? kreditor.name : null,
          kreditorId: kreditor ? kreditor.id : null,
          typ: jobTyp,
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
          eskalierenFreigabe1AnAdmin(db, job.id, { eskaliertVon: req.currentPerson.churchtools_person_id, grund: grundMitAusschluss(begruendung, sv1Ausschluss) });
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
        } else if (wirdWeitergeleitet) {
          if (weiterleitungsZiel.anAdmin) {
            eskalierenFreigabe1AnAdmin(db, job.id, {
              // Nur echte Konfliktmelder gehören hierher: der Kontierer hat keinen Konflikt erklärt
              // und darf durch die Weiterleitung nicht selbst gesperrt werden.
              eskaliertVon: job.freigabe1_eskaliert_von ?? null,
              grund: 'Strikte Freigeber-1-Prüfung: Freigeber 1 und Stellvertreter 1 sind für diesen Vorgang ausgeschlossen.',
            });
          } else {
            weiterleitenAnEchtenFreigeber1(db, job.id, weiterleitungsZiel.personId);
          }
          createFreigabe(db, { jobId: job.id, personId: req.currentPerson.churchtools_person_id, rolle: 'freigabe1_weiterleitung', zeitpunkt: new Date().toISOString(), ip: req.ip, interessenskonflikt: false, kommentar: begruendung || null, eskaliertVon: job.freigabe1_eskaliert_von });
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
            vertretungFuer: !job.freigabe1_eskaliert_an_admin && istAktiveVertretungFuer(db, req.currentPerson.churchtools_person_id, job.zugewiesen_an) ? job.zugewiesen_an : null,
          });
          abschliessenFreigabe1(db, job.id);
        }
        if (hash) {
          speichereBestaetigung(db, { jobId: job.id, personId: req.currentPerson.churchtools_person_id, befunde, bemerkung: pruefBemerkung });
          createFreigabe(db, {
            jobId: job.id,
            personId: req.currentPerson.churchtools_person_id,
            rolle: 'auffaelligkeiten_bestaetigt',
            zeitpunkt: new Date().toISOString(),
            ip: req.ip,
            interessenskonflikt: false,
            kommentar: bestaetigungsKommentar(befunde, pruefBemerkung),
            eskaliertVon: null,
          });
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }

      // Siehe Ablehnungs-Pfad oben: ein Splitkind erreicht auch die normale Kontierung -- etwa
      // eine per hinweis_konto_id angelegte Zeile, die aus dem Pool geclaimt wird, oder eine aus
      // der Interessenskonflikt-Eskalationsmail heraus geöffnete. Ein hier angehängter Beleg muss
      // deshalb genauso in beleg_seitenzahl einfliessen, sonst fehlt er später im Gruppendokument.
      if (req.file) {
        // Merge first, count second -- see the identical comment at the Ablehnungs-Pfad above.
        await mergeBelegFuerJob(job.pdf_pfad, req.file, belegMimetype);
        addBelegSeiten(db, job.id, await countBelegSeiten(req.file.buffer, belegMimetype));
      }

      if (ibanManuellNoetig) {
        const passt = ibanEndungPasst(db, kreditor.id, ibanEndung);
        createFreigabe(db, {
          jobId: job.id,
          personId: req.currentPerson.churchtools_person_id,
          rolle: 'iban_manuell_geprueft',
          zeitpunkt: new Date().toISOString(),
          ip: req.ip,
          interessenskonflikt: false,
          kommentar: `IBAN manuell geprüft: ${passt ? 'Übereinstimmung' : 'keine Übereinstimmung'} (Eingabe ${ibanEndung})`,
          eskaliertVon: null,
        });
      }

      if (hash) {
        const jobNachKontierung = getJobById(db, job.id);
        await sendeAuffaelligkeitenWarnung(db, mailer, config, {
          job,
          kreditor,
          befunde,
          bemerkung: pruefBemerkung,
          person: req.currentPerson,
          freigeberIds: [konto.freigeber1_id, konto.freigeber2_id],
          link: jobNachKontierung.status === 'freigabe2'
            ? `${config.publicBaseUrl}/freigabe2/${job.id}`
            : `${config.publicBaseUrl}/kontierung/${job.id}`,
        });
      }

      if (kreditor) {
        const duplikate = findJobsByKreditorUndRechnungsnummer(db, kreditor.id, rechnungsnummer, job.id);
        // Szenario 2 (Doppelscan, Rechnungsnummer evtl. anders abgetippt) — nur wenn die strengere
        // Rechnungsnummer-Prüfung nicht schon angeschlagen hat, damit es nur eine Warnung gibt.
        const doppelrechnungen = duplikate.length > 0
          ? []
          : findMoeglicheDoppelrechnungen(db, { job, kreditorId: kreditor.id, betrag: values.betrag, zahlungsziel: values.zahlungsziel });
        if (doppelrechnungen.length > 0) {
          const dupJobIds = doppelrechnungen.map((d) => `#${d.id}`).join(', ');
          const betragText = String(values.betrag).replace(',', '.');
          createFreigabe(db, {
            jobId: job.id,
            personId: req.currentPerson.churchtools_person_id,
            rolle: 'duplikat_verdacht',
            zeitpunkt: new Date().toISOString(),
            ip: req.ip,
            interessenskonflikt: false,
            kommentar: `Gleicher Lieferant (${kreditor.name}), Betrag ${betragText} und Zahlungsziel ${values.zahlungsziel} wie Job ${dupJobIds} (Eingang innerhalb von ${DOPPELRECHNUNG_FENSTER_TAGE} Tagen).`,
            eskaliertVon: null,
          });
          const empfaenger = new Set([req.currentPerson.email]);
          for (const personId of [konto.freigeber1_id, konto.freigeber2_id]) {
            const person = getPersonById(db, personId);
            if (person) empfaenger.add(person.email);
          }
          for (const email of empfaenger) {
            await sendNotification(db, mailer, {
              to: email,
              typ: 'duplikat-warnung',
              jobId: job.id,
              variablen: {
                jobDateiname: job.dateiname,
                ...kreditorNameVariablen(kreditor.name),
                betrag: betragText,
                zahlungsziel: values.zahlungsziel,
                tage: DOPPELRECHNUNG_FENSTER_TAGE,
                dupJobIds,
                link: `${config.publicBaseUrl}/kontierung/${job.id}`,
              },
            });
          }
        }
        if (duplikate.length > 0) {
          createFreigabe(db, {
            jobId: job.id,
            personId: req.currentPerson.churchtools_person_id,
            rolle: 'rechnungsnummer_duplikat',
            zeitpunkt: new Date().toISOString(),
            ip: req.ip,
            interessenskonflikt: false,
            kommentar: `Rechnungsnummer "${rechnungsnummer}" ist bei ${kreditor.name} bereits erfasst: Job ${duplikate.map((d) => `#${d.id}`).join(', ')}.`,
            eskaliertVon: null,
          });
          const zusatzEmpfaenger = new Set([req.currentPerson.email]);
          const freigeber1 = getPersonById(db, konto.freigeber1_id);
          const freigeber2 = getPersonById(db, konto.freigeber2_id);
          if (freigeber1) zusatzEmpfaenger.add(freigeber1.email);
          if (freigeber2) zusatzEmpfaenger.add(freigeber2.email);
          for (const email of zusatzEmpfaenger) {
            await sendNotification(db, mailer, {
              to: email,
              typ: 'rechnungsnummer-warnung',
              jobId: job.id,
              variablen: {
                jobDateiname: job.dateiname,
                ...kreditorNameVariablen(kreditor.name),
                rechnungsnummer,
                dupJobIds: duplikate.map((d) => `#${d.id}`).join(', '),
                link: `${config.publicBaseUrl}/kontierung/${job.id}`,
              },
            });
          }
        }
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
              grund: adminEskalationsText('Eine Rechnung', sv1Ausschluss),
              link: `${config.publicBaseUrl}/kontierung/${job.id}`,
            },
          });
        }
      } else if (hatKonflikt) {
        const stellvertreter1 = getPersonById(db, konto.stellvertreter1_id);
        if (stellvertreter1) {
          await sendNotification(db, mailer, {
            to: stellvertreter1.email,
            typ: 'zuweisung',
            jobId: job.id,
            variablen: {
              empfaengerName: `${stellvertreter1.vorname} ${stellvertreter1.nachname}`,
              jobDateiname: job.dateiname,
              grund: `Eine Rechnung wurde dir zur Kontierung übergeben, da ${req.currentPerson.vorname} ${req.currentPerson.nachname} einen Interessenskonflikt erklärt hat.`,
              link: `${config.publicBaseUrl}/kontierung/${job.id}`,
            },
          });
        }
      } else if (wirdWeitergeleitet && weiterleitungsZiel.anAdmin) {
        const empfaenger = resolveEmpfaenger(db, config, 'gruppe:admin');
        for (const email of empfaenger) {
          await sendNotification(db, mailer, {
            to: email,
            typ: 'zuweisung',
            jobId: job.id,
            variablen: {
              empfaengerName: 'Portal-Admin-Team',
              jobDateiname: job.dateiname,
              grund: 'Eine Rechnung wurde an die Portal-Admin-Gruppe eskaliert, da Freigeber 1 und Stellvertreter 1 für diesen Vorgang ausgeschlossen sind.',
              link: `${config.publicBaseUrl}/kontierung/${job.id}`,
            },
          });
        }
      } else if (wirdWeitergeleitet) {
        const echterFreigeber1 = getPersonById(db, weiterleitungsZiel.personId);
        if (echterFreigeber1) {
          await sendNotificationMitVertretung(db, mailer, {
            person: echterFreigeber1,
            typ: 'zuweisung',
            jobId: job.id,
            variablen: {
              jobDateiname: job.dateiname,
              grund: `Eine Rechnung wurde von ${req.currentPerson.vorname} ${req.currentPerson.nachname} kontiert und wartet auf deine Freigabe 1.`,
              link: `${config.publicBaseUrl}/kontierung/${job.id}`,
            },
          });
        }
      } else {
        // abschliessenFreigabe1 kann den Vorgang an die Admin-Gruppe gegeben haben (effektive
        // Freigabe-2-Person hat für diese Rechnung bereits einen Konflikt erklärt): neu lesen.
        const jobNachFreigabe1 = getJobById(db, job.id);
        if (jobNachFreigabe1.freigabe2_eskaliert_an_admin) {
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
        } else {
          const freigeber2 = getPersonById(db, getEffectiveFreigeber2Id(jobNachFreigabe1, konto));
          if (freigeber2) {
            await sendNotificationMitVertretung(db, mailer, {
              person: freigeber2,
              typ: 'zuweisung',
              jobId: job.id,
              variablen: {
                jobDateiname: job.dateiname,
                grund: 'Eine Rechnung wartet auf deine Freigabe 2.',
                link: `${config.publicBaseUrl}/freigabe2/${job.id}`,
              },
            });
          }
        }
      }

      res.redirect('/pool');
    } catch (err) {
      next(err);
    }
    }));
    }));
  });

  router.post('/:id/zurueck-in-pool', csrfProtection, asyncHandler(async (req, res, next) => {
    try {
      const job = loadAuthorizedJob(req, res, { zurueckgeben: true });
      if (!job) return;
      if (sperreKkAbrechnung(job, res)) return;

      // The hint is best-effort, not a hard requirement — an unparseable, non-existent, or
      // deactivated Konto id is simply ignored (releases the job exactly as if no hint had been
      // given) rather than blocking the release or erroring out.
      const hinweisKonto = req.body.hinweisKontoId ? getKontoById(db, Number(req.body.hinweisKontoId)) : null;
      const gueltigerHinweis = hinweisKonto && hinweisKonto.aktiv ? hinweisKonto : null;

      // Use job.zugewiesen_an, not req.currentPerson.churchtools_person_id: releaseJob's guard
      // requires zugewiesen_an to match the person passed in, and for a Portal-Admin authorized
      // via the freigabe1_eskaliert_an_admin branch, the admin's own ID never equals
      // job.zugewiesen_an (still the excluded Stellvertreter1's ID) — passing the admin's ID would
      // silently match zero rows while still redirecting to /pool as if it had succeeded. For the
      // ordinary (non-admin) path this is definitionally identical, since loadAuthorizedJob already
      // verified job.zugewiesen_an === req.currentPerson.churchtools_person_id to get here.
      releaseJob(db, job.id, job.zugewiesen_an, { hinweisKontoId: gueltigerHinweis ? gueltigerHinweis.id : null });

      if (gueltigerHinweis) {
        const freigeber1 = getPersonById(db, gueltigerHinweis.freigeber1_id);
        if (freigeber1) {
          await sendNotification(db, mailer, {
            to: freigeber1.email,
            typ: 'zuweisung',
            jobId: job.id,
            variablen: {
              empfaengerName: `${freigeber1.vorname} ${freigeber1.nachname}`,
              jobDateiname: job.dateiname,
              grund: `Eine Rechnung wurde mit dem Hinweis in den Pool zurückgelegt, dass sie vermutlich für dein Konto ${gueltigerHinweis.kontonummer} — ${gueltigerHinweis.bezeichnung} bestimmt ist.`,
              link: `${config.publicBaseUrl}/pool`,
            },
          });
        }
      }

      res.redirect('/pool');
    } catch (err) {
      next(err);
    }
  }));

  router.post('/:id/an-gruppe-zurueck', csrfProtection, (req, res) => {
    const job = loadAuthorizedJob(req, res, { zurueckgeben: true });
    if (!job) return;
    if (sperreKkAbrechnung(job, res)) return;

    const bemerkung = (req.body.bemerkung || '').trim();
    if (!bemerkung) {
      return res.status(400).render('error', { message: 'Bitte eine Bemerkung angeben.' });
    }

    sendJobBackToGroup(db, job.id, job.zugewiesen_an, { bemerkung });
    createFreigabe(db, {
      jobId: job.id,
      personId: req.currentPerson.churchtools_person_id,
      rolle: 'pool_ruecksendung',
      zeitpunkt: new Date().toISOString(),
      ip: req.ip,
      interessenskonflikt: false,
      kommentar: bemerkung,
      eskaliertVon: null,
    });
    res.redirect('/pool');
  });

  router.post('/:id/als-kk-abrechnung', csrfProtection, asyncHandler(async (req, res, next) => {
    try {
      const job = loadAuthorizedJob(req, res);
      if (!job) return;
      if (getConfigValue(db, 'modul_kreditkarten_aktiv') !== '1') {
        return res.status(403).render('error', { message: 'Die Kreditkarten-Belege sind derzeit deaktiviert.' });
      }
      const karte = getKreditkarteById(db, Number(req.body.kreditkarteId));
      if (!karte || !karte.aktiv) return res.status(400).render('error', { message: 'Bitte eine gültige Karte wählen.' });
      const ok = await markiereAlsKkAbrechnung(db, config, mailer, { job, karte, markiertVon: req.currentPerson, ip: req.ip, ausStatus: 'zugewiesen' });
      if (!ok) return res.status(409).render('error', { message: 'Diese Rechnung wurde inzwischen bereits von einem anderen Vorgang bearbeitet.' });
      res.redirect(karte.verantwortlich_id === req.currentPerson.churchtools_person_id ? `/kontierung/${job.id}/kk-abgleich` : '/pool');
    } catch (err) {
      next(err);
    }
  }));

  router.post('/:id/rapport-aufheben', csrfProtection, asyncHandler(async (req, res, next) => {
    try {
      const vorher = getJobById(db, Number(req.params.id));
      const ergebnis = await hebeRapportAuf(db, config, { jobId: Number(req.params.id), person: req.currentPerson, ip: req.ip });
      if (!ergebnis.ok) return res.status(ergebnis.status).render('error', { message: ergebnis.fehler });
      // Der Beleg geht an die markierende Person zurück; nur sie kann die Kontierung öffnen.
      const istMarkierer = vorher?.rapport_markiert_von === req.currentPerson.churchtools_person_id;
      res.redirect(istMarkierer ? `/kontierung/${req.params.id}` : '/pool');
    } catch (err) {
      next(err);
    }
  }));

  router.post('/:id/kk-markierung-aufheben', csrfProtection, (req, res) => {
    const job = loadAuthorizedJob(req, res);
    if (!job) return;
    if (!job.kreditkarte_id) return res.status(409).render('error', { message: 'Diese Abrechnung ist keiner Kreditkarte zugeordnet.' });
    const bemerkung = (req.body.bemerkung || '').trim();
    if (!bemerkung) return res.status(400).render('error', { message: 'Bitte eine Bemerkung angeben.' });
    db.exec('BEGIN');
    let ok = false;
    try {
      ok = hebeKkMarkierungAuf(db, job.id) && sendJobBackToGroup(db, job.id, job.zugewiesen_an, { bemerkung });
      if (ok) {
        createFreigabe(db, {
          jobId: job.id, personId: req.currentPerson.churchtools_person_id, rolle: 'kk_markierung_aufgehoben',
          zeitpunkt: new Date().toISOString(), ip: req.ip, interessenskonflikt: false, kommentar: bemerkung, eskaliertVon: null,
        });
      }
      db.exec(ok ? 'COMMIT' : 'ROLLBACK');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    if (!ok) return res.status(409).render('error', { message: 'Diese Abrechnung wurde inzwischen bereits von einem anderen Vorgang bearbeitet.' });
    res.redirect('/pool');
  });

  // `extra`: ibanEndung, pruefBemerkung und — in der Popup-Runde — auffaelligkeiten.
  // Ein unbestätigter Popup-Durchgang hinterlässt eine Spur im Audit-Log, damit das Popup nicht
  // unbemerkt als Orakel für die letzten 4 IBAN-Zeichen dienen kann (man tippt so lange, bis kein
  // iban_manuell_fremd mehr kommt). Bewusst nur die Befund-Codes — nie die Eingabe oder eine IBAN.
  function protokolliereAngezeigteAuffaelligkeiten(jobId, person, befunde) {
    db.prepare(`INSERT INTO audit_ereignisse (zeitpunkt, person_id, person_name, objekt, objekt_id, aktion, nachher)
      VALUES (?, ?, ?, 'kontierung', ?, 'auffaelligkeiten_angezeigt', ?)`).run(
      new Date().toISOString(),
      person.churchtools_person_id,
      `${person.vorname ?? ''} ${person.nachname ?? ''}`.trim() || person.churchtools_person_id,
      String(jobId),
      JSON.stringify({ codes: befunde.map((b) => b.code) }),
    );
  }

  function renderAufsplittenForm(req, res, status, job, konten, alleKonten, gesamtbetrag, teile, begruendung, errors, typ, extra = {}) {
    const kreditoren = listKreditorenWaehlbar(db);
    const kreditorId = extra.kreditorId || '';
    const gewaehlterKreditor = kreditoren.find((k) => String(k.id) === kreditorId) || null;
    res.status(status).render('kontierung-aufsplitten', {
      job, konten, alleKonten, gesamtbetrag, teile, begruendung, errors, typ, kreditoren,
      // Ohne QR-Code steht der IBAN-Kasten immer im Formular; sichtbar und Pflicht nur, wenn der
      // gewählte Lieferant eine IBAN braucht und Typ Rechnung gewählt ist (kontierung-iban.js).
      ibanKasten: !job.qr_iban,
      ibanKastenSichtbar: !job.qr_iban && Boolean(gewaehlterKreditor) && brauchtManuelleIbanPruefung(job, gewaehlterKreditor, typ),
      lieferantFehler: Boolean(extra.lieferantFehler),
      values: { kreditorId, ibanEndung: extra.ibanEndung || '', pruefBemerkung: extra.pruefBemerkung || '' },
      auffaelligkeiten: extra.auffaelligkeiten || null,
    });
  }

  // Eine aufgesplittete Rechnung hat genau einen Typ für alle Teile — eine Mischung aus Rechnung
  // und Gutschrift innerhalb eines Belegs gibt es nicht. Unbekannte Werte gelten als Rechnung,
  // wie in der normalen Kontierung.
  const normalisiereTyp = (typ) => (typ === 'gutschrift' ? 'gutschrift' : 'rechnung');

  router.get('/:id/aufsplitten', (req, res) => {
    const job = loadAuthorizedJob(req, res);
    if (!job) return;
    if (sperreKkAbrechnung(job, res)) return;
    const konten = ladeKontenFuerJob(req, job);
    // The Kontierung form's own Betrag field (already pre-filled from the original Rechnung —
    // QR-erkannt or previously saved) is passed in as ?betrag=... when the Aufsplitten-Popup is
    // opened, so a value the person typed there but hasn't saved yet still shows up here instead
    // of falling back to whatever is (or isn't) persisted on the job.
    const queryBetrag = typeof req.query.betrag === 'string' && BETRAG_PATTERN.test(req.query.betrag) ? req.query.betrag : null;
    // Wie beim Betrag: ein im Kontierungsformular gewählter, noch nicht gespeicherter Typ kommt
    // als ?typ=... mit und hat Vorrang vor dem gespeicherten.
    const typ = normalisiereTyp(req.query.typ === 'gutschrift' || req.query.typ === 'rechnung' ? req.query.typ : job.typ);
    // Und der im Kontierungsformular gewählte Lieferant (?kreditorId=...), sonst der am Beleg.
    // renderAufsplittenForm wählt ihn nur vor, wenn er wählbar ist.
    const queryKreditorId = typeof req.query.kreditorId === 'string' && /^\d+$/.test(req.query.kreditorId) ? req.query.kreditorId : null;
    renderAufsplittenForm(req, res, 200, job, konten, listKonten(db), queryBetrag || job.betrag || '', [
      { kontoId: '', betrag: '', interessenskonflikt: false },
      { kontoId: '', betrag: '', interessenskonflikt: false },
    ], '', [], typ, { kreditorId: queryKreditorId || (job.kreditor_id ? String(job.kreditor_id) : '') });
  });

  router.post('/:id/aufsplitten', (req, res, next) => {
    mitAuditKontext(uploadBeleg.any())(req, res, asyncCallback(next, async (uploadErr) => {
    // csrfProtection runs after multer parses the multipart body (the _csrf field included) —
    // any earlier and req.body would still be empty, rejecting every legitimate submission.
    csrfProtection(req, res, asyncCallback(next, async (csrfErr) => {
    if (csrfErr) return next(csrfErr);
    try {
      const job = loadAuthorizedJob(req, res);
      if (!job) return;
      if (sperreKkAbrechnung(job, res)) return;
      const konten = ladeKontenFuerJob(req, job);
      const alleKonten = listKonten(db);

      const gesamtbetrag = req.body.gesamtbetrag || '';
      const kontoIds = [].concat(req.body.teilKontoId || []);
      const betraege = [].concat(req.body.teilBetrag || []);
      const konflikte = [].concat(req.body.teilInteressenskonflikt || []);
      const positionen = [].concat(req.body.teilPosition || []);
      const begruendung = req.body.begruendung || '';
      const typ = normalisiereTyp(req.body.typ);
      const kreditorIdEingabe = typeof req.body.kreditorId === 'string' ? req.body.kreditorId.trim() : '';
      const ibanEndung = normalizeIban(typeof req.body.ibanEndung === 'string' ? req.body.ibanEndung : '');
      const pruefBemerkung = (typeof req.body.pruefBemerkung === 'string' ? req.body.pruefBemerkung.trim() : '').slice(0, PRUEF_BEMERKUNG_MAX);
      const teileEingabe = kontoIds.map((kontoId, i) => ({
        kontoId,
        betrag: betraege[i] || '',
        interessenskonflikt: konflikte[i] === 'true',
        position: (positionen[i] || '').trim() || null,
      }));

      const errors = [];
      if (uploadErr) {
        errors.push(uploadErr.code === 'LIMIT_FILE_SIZE' ? 'Ein Beleg darf höchstens 20 MB gross sein.' : 'Fehler beim Datei-Upload.');
      }
      if (!gesamtbetrag || !BETRAG_PATTERN.test(gesamtbetrag)) {
        errors.push('Bitte einen gültigen Gesamtbetrag erfassen (z.B. 200.00).');
      }
      if (teileEingabe.filter((t) => t.kontoId || t.betrag).length < 2) {
        errors.push('Mindestens zwei Teilbeträge sind nötig, um aufzusplitten.');
      }

      // The browser renames each row's file input to teilBeleg_<i> at submit time, matching that
      // row's current position — see kontierung-aufsplitten.ejs. Matched against aufgeloesteTeile
      // below via originalIndex, not array position, since blank rows are filtered out there.
      const teilBelegByIndex = new Map();
      for (const file of req.files || []) {
        const match = /^teilBeleg_(\d+)$/.exec(file.fieldname);
        if (!match) continue;
        const mimetype = detectBelegMimetype(file.buffer);
        if (!mimetype || mimetype !== file.mimetype) {
          errors.push('Beleg muss eine PDF-, PNG- oder JPEG-Datei sein.');
          continue;
        }
        teilBelegByIndex.set(Number(match[1]), { file, mimetype });
      }

      const aufgeloesteTeile = [];
      teileEingabe.forEach((teil, originalIndex) => {
        if (!teil.kontoId && !teil.betrag) return;
        const konto = alleKonten.find((k) => String(k.id) === teil.kontoId);
        if (!konto) {
          errors.push('Bitte für jede Zeile ein gültiges Konto auswählen.');
          return;
        }
        if (!kontoErlaubtFuerTyp(konto, typ)) {
          errors.push(`Konto ${konto.kontonummer}: Dieses Konto kann nicht für ${typ === 'gutschrift' ? 'Gutschriften' : 'Rechnungen'} verwendet werden.`);
          return;
        }
        if (!teil.betrag || !BETRAG_PATTERN.test(teil.betrag)) {
          errors.push('Jede Zeile braucht einen gültigen Betrag (z.B. 123.45).');
          return;
        }
        if (teil.position && !POSITION_PATTERN.test(teil.position)) {
          errors.push('Position auf der Rechnung darf keine Sonderzeichen enthalten (z.B. Emoji), die nicht gestempelt werden können.');
          return;
        }
        const belegEintrag = teilBelegByIndex.get(originalIndex);
        aufgeloesteTeile.push({
          konto, betrag: teil.betrag.replace(',', '.'), interessenskonflikt: teil.interessenskonflikt, position: teil.position, originalIndex, typ,
          beleg: belegEintrag ? { buffer: belegEintrag.file.buffer, mimetype: belegEintrag.mimetype } : null,
        });
      });

      // Ein Lieferant für die ganze Rechnung (nicht pro Zeile), Pflicht wie bei der Kontierung: ohne
      // ihn liefe die Prüfung ins Leere (keine Befunde, Kinder ohne kreditor_id, später kein
      // IBAN-Abgleich bei der Zahlung). Pool-Belege haben meist noch keinen am Beleg, deshalb kommt er
      // aus dem Formular (vorgewählt aus der Kontierung bzw. job.kreditor_id). Nur aktive und
      // vollständige Lieferanten, wie in listKreditorenWaehlbar.
      const gefundenerKreditor = /^\d+$/.test(kreditorIdEingabe) ? getKreditorById(db, Number(kreditorIdEingabe)) : null;
      let jobKreditor = null;
      let lieferantFehler = false;
      if (!gefundenerKreditor || !gefundenerKreditor.aktiv) {
        errors.push('Bitte einen gültigen Lieferanten aus der Liste auswählen.');
        lieferantFehler = true;
      } else if (!istKreditorVollstaendig(db, gefundenerKreditor)) {
        errors.push('Dieser Lieferant hat noch keine IBAN. Bitte melde dich bei der Administration.');
        lieferantFehler = true;
      } else {
        jobKreditor = gefundenerKreditor;
      }
      const ibanManuellNoetig = Boolean(jobKreditor) && brauchtManuelleIbanPruefung(job, jobKreditor, typ);
      if (ibanManuellNoetig && !IBAN_ENDUNG_PATTERN.test(ibanEndung)) {
        errors.push(IBAN_ENDUNG_FEHLER);
      }

      if (errors.length === 0) {
        const summe = aufgeloesteTeile.reduce((sum, t) => sum + Number(t.betrag), 0);
        const original = Number(gesamtbetrag.replace(',', '.'));
        if (Math.abs(summe - original) > 0.005) {
          errors.push(`Die Summe der Teilbeträge (${summe.toFixed(2)}) muss dem Gesamtbetrag (${original.toFixed(2)}) entsprechen.`);
        }
      }

      // Nur Zeilen auf eigenen Konten (in `konten`, inkl. des Admin-Eskalations-Fallbacks aus
      // ladeKontenFuerJob) können überhaupt einen Interessenskonflikt haben — für ein fremdes
      // Konto ist die Checkbox bedeutungslos, siehe Design-Spec.
      const hatKonflikt = aufgeloesteTeile.some((t) => t.interessenskonflikt && konten.some((k) => k.id === t.konto.id));
      if (hatKonflikt && !begruendung) {
        errors.push('Bei einem Interessenskonflikt ist eine Begründung Pflicht.');
      }

      if (errors.length > 0) {
        return renderAufsplittenForm(req, res, 400, job, konten, alleKonten, gesamtbetrag, teileEingabe, begruendung, errors, typ, { kreditorId: kreditorIdEingabe, lieferantFehler, ibanEndung, pruefBemerkung });
      }

      // Prüf-Popup wie bei der Kontierung (Spec B6), aber einmal für die ganze Rechnung: gegen den
      // gewählten Lieferanten, verglichen wird der Gesamtbetrag (auch gegen den QR-Betrag). Ein
      // Hash; ohne passende Bestätigung wird nichts angelegt und keine Mail verschickt.
      const befunde = ermittleBefunde(db, { job, kreditor: jobKreditor, betrag: gesamtbetrag, typ, ibanEndung: ibanManuellNoetig ? ibanEndung : null });
      const hash = befunde.length > 0 ? befundeHash(befunde) : null;
      if (hash && req.body.auffaelligkeitenHash !== hash) {
        protokolliereAngezeigteAuffaelligkeiten(job.id, req.currentPerson, befunde);
        // Datei-Felder lassen sich nicht vorbefüllen: für jede Zeile mit Beleg ein eigenes Feld im
        // Modal, unter dem Namen, den die Zeile beim Absenden bekäme (Zeilen werden in derselben
        // Reihenfolge neu gerendert).
        const belegFelder = [...teilBelegByIndex.keys()].sort((a, b) => a - b).map((index) => ({
          id: `auffaelligkeiten-teil-beleg-${index}`,
          name: `teilBeleg_${index}`,
          label: `Einen Beleg für Zeile ${index + 1} hast du noch nicht gespeichert. Bitte wähle ihn hier nochmals aus, bevor du speicherst.`,
        }));
        return renderAufsplittenForm(req, res, 200, job, konten, alleKonten, gesamtbetrag, teileEingabe, begruendung, [], typ, {
          kreditorId: kreditorIdEingabe,
          ibanEndung,
          pruefBemerkung,
          auffaelligkeiten: { befunde, hash, zeigeTelefonHinweis: befunde.some((b) => b.code.startsWith('iban')), belegFelder },
        });
      }

      // Persisted on the parent even though it's about to be retired: the parent may never have
      // had a Betrag saved before (that's exactly the gap this Gesamtbetrag field closes), and
      // its own record should reflect the real total the split was based on, not stay empty.
      job.betrag = gesamtbetrag.replace(',', '.');

      // File I/O (including the async Beleg merge) happens before the DB transaction below —
      // see bereiteTeilDateienVor in services/aufsplitten.js.
      const vorbereiteteTeile = await bereiteTeilDateienVor(config, job, aufgeloesteTeile);

      let ergebnis;
      let kindIds = [];
      db.exec('BEGIN');
      try {
        setJobBetrag(db, job.id, job.betrag);
        setJobTyp(db, job.id, typ);
        // Vor erzeugeTeilJobs: createSplitJob übernimmt kreditor_id und lieferant vom Elternjob-Objekt.
        setJobKreditor(db, job.id, { kreditorId: jobKreditor.id, lieferant: jobKreditor.name });
        job.kreditor_id = jobKreditor.id;
        job.lieferant = jobKreditor.name;
        const markiert = markJobAufgesplittet(db, job.id);
        if (!markiert) {
          db.exec('ROLLBACK');
          return res.status(409).render('error', { message: 'Diese Rechnung wurde inzwischen bereits von einem anderen Vorgang bearbeitet.' });
        }
        ergebnis = erzeugeTeilJobs(db, {
          job,
          teile: vorbereiteteTeile,
          konten,
          person: req.currentPerson,
          ip: req.ip,
          begruendung,
          fremdKontoModus: 'pool',
          istVertretung: !job.freigabe1_eskaliert_an_admin && istAktiveVertretungFuer(db, req.currentPerson.churchtools_person_id, job.zugewiesen_an),
        });
        // Befunde und manuelle IBAN-Prüfung gelten für die ganze Rechnung: an jedem Kind protokolliert,
        // damit der Audit-Log jedes Teils sie zeigt.
        kindIds = alleKindIds(ergebnis);
        const zeitpunkt = new Date().toISOString();
        const personId = req.currentPerson.churchtools_person_id;
        const ibanPasst = ibanManuellNoetig ? ibanEndungPasst(db, jobKreditor.id, ibanEndung) : null;
        for (const kindId of kindIds) {
          if (hash) {
            speichereBestaetigung(db, { jobId: kindId, personId, befunde, bemerkung: pruefBemerkung });
            createFreigabe(db, {
              jobId: kindId, personId, rolle: 'auffaelligkeiten_bestaetigt', zeitpunkt, ip: req.ip,
              interessenskonflikt: false, kommentar: bestaetigungsKommentar(befunde, pruefBemerkung), eskaliertVon: null,
            });
          }
          if (ibanManuellNoetig) {
            createFreigabe(db, {
              jobId: kindId, personId, rolle: 'iban_manuell_geprueft', zeitpunkt, ip: req.ip, interessenskonflikt: false,
              kommentar: `IBAN manuell geprüft: ${ibanPasst ? 'Übereinstimmung' : 'keine Übereinstimmung'} (Eingabe ${ibanEndung})`,
              eskaliertVon: null,
            });
          }
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }

      await benachrichtigeNachAufsplitten(db, mailer, config, { job, ergebnis, person: req.currentPerson });

      if (hash) {
        // Eine Mail-Runde für die ganze Rechnung, protokolliert am Elternjob (Originalrechnung).
        // Empfänger: Freigeber 1 + 2 aller Teil-Konten (auch fremder: ihr Teil liegt im Pool),
        // die splittende Person und iban_abweichung_empfaenger.
        // Link: aufs erste Kind, das die splittende Person selbst freigegeben hat (Freigabe 2 offen),
        // denn ein Pool- oder Eskalations-Kind auf einem fremden Konto könnten die meisten Empfänger
        // nicht öffnen. Gibt es keins, auf den Pool: dort liegen die übrigen Teile, und der Elternjob
        // selbst ist nach dem Aufsplitten nirgends mehr zu öffnen.
        const selbstFreigegebenId = ergebnis.selbstFreigegeben.map((e) => e.id).sort((a, b) => a - b)[0];
        const selbstFreigegeben = selbstFreigegebenId ? getJobById(db, selbstFreigegebenId) : null;
        let link = `${config.publicBaseUrl}/pool`;
        if (selbstFreigegeben) {
          link = selbstFreigegeben.status === 'freigabe2'
            ? `${config.publicBaseUrl}/freigabe2/${selbstFreigegeben.id}`
            : `${config.publicBaseUrl}/kontierung/${selbstFreigegeben.id}`;
        }
        await sendeAuffaelligkeitenWarnung(db, mailer, config, {
          job,
          kreditor: jobKreditor,
          befunde,
          bemerkung: pruefBemerkung,
          person: req.currentPerson,
          freigeberIds: aufgeloesteTeile.flatMap((t) => [t.konto.freigeber1_id, t.konto.freigeber2_id]),
          link,
        });
      }

      res.redirect('/pool');
    } catch (err) {
      next(err);
    }
    }));
    }));
  });

  return router;
}
