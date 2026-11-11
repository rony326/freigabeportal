// Admin-Seite "Benachrichtigungen": ein Ereignis pro URL mit den Blöcken Wann (Zeiten/Schwellen),
// Wer (Zusatzempfänger) und Was (Mail-Vorlage). Ersetzt /admin/eskalation und
// /admin/mail-einstellungen; die Werte liegen weiter in admin_config.
import { Router } from 'express';
import { DEFAULTS, getConfigValue, setConfigValue } from '../../db/adminConfigRepo.js';
import { listRecentCronLog } from '../../db/cronLogRepo.js';
import { listGeplantMailsGruppiertNachEmpfaenger } from '../../db/mailLogRepo.js';
import { BEREICHE, EREIGNISSE, findeEreignis } from '../../services/benachrichtigungsEreignisse.js';
import { TYP_ZU_KEY_INFIX } from '../../services/mailTemplates.js';
import { renderBenachrichtigung, sendRenderedMail } from '../../services/notify.js';
import { validateEmpfaengerListe, empfaengerZeilen, empfaengerAnzeige, adminAdressen } from '../../services/empfaenger.js';
import { parseEmpfaengerListe, meldeAuditEmpfaengerWechsel, meldeAuditNachweisAenderung } from '../../services/auditNachweisJobs.js';
import { BENACHRICHTIGUNG_WERTE, WOCHENTAG_NAMEN, benachrichtigungFuer } from '../../services/benachrichtigung.js';
import { stelleWartendeSofortZu } from '../../services/mailZustellung.js';
import { runMailDigestJob } from '../../services/cronJobs.js';
import { currentAuditActor } from '../../services/auditContext.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';

const BASIS = '/admin/benachrichtigungen';
const DIGEST_LOG_LIMIT = 10;
const STANDARD_WAHL = [['sofort', 'Sofort'], ['taeglich', 'Täglich'], ['woechentlich', 'Wöchentlich']];
const TESTMAIL_HINWEISE = {
  versendet: { art: 'success', text: (mail) => `Test-Mail an ${mail} verschickt.` },
  eingereiht: { art: 'warning', text: (mail) => `Die Test-Mail an ${mail} konnte noch nicht zugestellt werden, das Portal versucht es erneut.` },
  fehlgeschlagen: { art: 'danger', text: (mail) => `Die Test-Mail an ${mail} konnte nicht zugestellt werden. Prüfe das Mail-Protokoll.` },
  'keine-adresse': { art: 'danger', text: () => 'Für dein Konto ist keine E-Mail-Adresse hinterlegt.' },
};

// Prüfregeln pro Einheit der Ereignis-Definition. Sonderfälle der Zusammenfassung über den Schlüssel.
const ZAHL_REGELN = {
  mail_digest_wochentag: { muster: /^\d+$/, gueltig: (n) => n >= 1 && n <= 7, fehler: 'muss zwischen Montag und Sonntag liegen' },
  mail_batching_stunde: { muster: /^\d+$/, gueltig: (n) => n <= 23, fehler: 'muss eine Ganzzahl zwischen 0 und 23 sein' },
  mail_batching_minute: { muster: /^\d+$/, gueltig: (n) => n <= 59, fehler: 'muss eine Ganzzahl zwischen 0 und 59 sein' },
  Stunden: { muster: /^\d+$/, gueltig: (n) => n > 0, fehler: 'muss eine positive Ganzzahl sein' },
  Anzahl: { muster: /^\d+$/, gueltig: (n) => n > 0, fehler: 'muss eine positive Ganzzahl sein' },
  Tage: { muster: /^\d+$/, gueltig: (n) => n > 0, fehler: 'muss eine positive Ganzzahl sein' },
  Faktor: { muster: /^\d+(\.\d+)?$/, gueltig: (n) => n > 1, fehler: 'muss eine Zahl grösser als 1 sein (Dezimalpunkt, z. B. 2.5)' },
  CHF: { muster: /^\d+(\.\d{1,2})?$/, gueltig: (n) => n >= 0, fehler: 'muss ein Betrag ab 0 sein (Dezimalpunkt, z. B. 500 oder 99.50)' },
};

const vorlagenKeys = (ereignis) => {
  const infix = TYP_ZU_KEY_INFIX[ereignis.vorlagenTyp];
  return { betreff: `mail_vorlage_${infix}_betreff`, text: `mail_vorlage_${infix}_text` };
};
// Textareas kommen als CRLF: auf LF vereinheitlichen, damit Vergleiche und Mails konsistent sind.
const normalisiereText = (wert) => String(wert ?? '').replace(/\r\n?/g, '\n').trim();
const beispielVariablen = (ereignis) => Object.fromEntries(ereignis.variablen.map((v) => [v.name, v.beispiel]));
const nurEmail = (ereignis) => ereignis.empfaengerArt === 'nurEmail';
// Audit-Empfänger sind kommagetrennt gespeichert; im Formular eine Adresse pro Zeile.
const auditAdressen = (wert) => parseEmpfaengerListe(String(wert ?? '').replace(/\r?\n|\r/g, ','));

function istAngepasst(db, ereignis) {
  if (!ereignis.vorlagenTyp) return false;
  const keys = vorlagenKeys(ereignis);
  return getConfigValue(db, keys.betreff) !== DEFAULTS[keys.betreff] || getConfigValue(db, keys.text) !== DEFAULTS[keys.text];
}

function gespeicherteWerte(db, ereignis) {
  const zeit = Object.fromEntries(ereignis.zeitKeys.map(({ key }) => [key, getConfigValue(db, key) ?? DEFAULTS[key] ?? '']));
  let empfaenger = '';
  if (ereignis.empfaengerKey) {
    const roh = getConfigValue(db, ereignis.empfaengerKey) ?? '';
    empfaenger = nurEmail(ereignis) ? parseEmpfaengerListe(roh).adressen.join('\n') : empfaengerZeilen(roh).join('\n');
  }
  const vorlage = ereignis.vorlagenTyp
    ? { betreff: getConfigValue(db, vorlagenKeys(ereignis).betreff) ?? '', text: getConfigValue(db, vorlagenKeys(ereignis).text) ?? '' }
    : { betreff: '', text: '' };
  return { zeit, empfaenger, ...vorlage };
}

// Prüft das Formular eines Ereignisses. Liefert die zu speichernden Werte (normalisiert) und Fehler.
function pruefeFormular(db, ereignis, body) {
  const errors = [];
  const eingabe = { zeit: {}, empfaenger: String(body.empfaenger ?? ''), betreff: String(body.betreff ?? ''), text: String(body.text ?? '') };
  const speichern = {};

  for (const { key, label, einheit } of ereignis.zeitKeys) {
    const wert = String(body[`zeit_${key}`] ?? '').trim();
    eingabe.zeit[key] = wert;
    if (key === 'mail_standard_benachrichtigung') {
      if (BENACHRICHTIGUNG_WERTE.includes(wert)) speichern[key] = wert;
      else errors.push(`${label}: muss sofort, täglich oder wöchentlich sein.`);
      continue;
    }
    const regel = ZAHL_REGELN[key] ?? ZAHL_REGELN[einheit];
    if (regel.muster.test(wert) && regel.gueltig(Number(wert))) speichern[key] = String(Number(wert));
    else errors.push(`${label}: ${regel.fehler}.`);
  }

  if (ereignis.empfaengerKey) {
    if (nurEmail(ereignis)) {
      const { adressen, ungueltig } = auditAdressen(eingabe.empfaenger);
      if (ungueltig.length > 0) errors.push(`Ungültige Mailadresse: ${ungueltig.join(', ')}. Hier sind nur E-Mail-Adressen möglich.`);
      else if (adressen.length === 0 && !ereignis.empfaengerLeerErlaubt) errors.push('Empfänger: braucht mindestens eine Adresse.');
      speichern[ereignis.empfaengerKey] = adressen.join(', ');
    } else {
      validateEmpfaengerListe(eingabe.empfaenger, 'Empfänger', errors, { db, leerErlaubt: ereignis.empfaengerLeerErlaubt });
      speichern[ereignis.empfaengerKey] = empfaengerZeilen(eingabe.empfaenger).join('\n');
    }
  }

  if (ereignis.vorlagenTyp) {
    const keys = vorlagenKeys(ereignis);
    const betreff = normalisiereText(eingabe.betreff);
    const text = normalisiereText(eingabe.text);
    if (!betreff) errors.push('Betreff darf nicht leer sein.');
    if (!text) errors.push('Text darf nicht leer sein.');
    speichern[keys.betreff] = betreff;
    speichern[keys.text] = text;
  }
  return { errors, eingabe, speichern };
}

function speichereWerte(db, werte) {
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const [key, value] of Object.entries(werte)) setConfigValue(db, key, value);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// Änderungen an der Prüfnummer-Vorlage gehen an die Revision (ohne Vorlageninhalt).
function auditVorlagenAenderungen(db, ereignis, neu) {
  if (ereignis.id !== 'audit-pruefnummer') return [];
  const keys = vorlagenKeys(ereignis);
  const aenderungen = [];
  if (getConfigValue(db, keys.betreff) !== neu[keys.betreff]) aenderungen.push('Betreff der Prüfnummer-Mail wurde geändert');
  if (getConfigValue(db, keys.text) !== neu[keys.text]) aenderungen.push('Text der Prüfnummer-Mail wurde geändert');
  return aenderungen;
}

function schreibeTestmailAudit(db, ereignis, status) {
  const actor = currentAuditActor();
  db.prepare(`INSERT INTO audit_ereignisse (zeitpunkt, person_id, person_name, objekt, objekt_id, aktion, nachher)
    VALUES (?, ?, ?, 'benachrichtigung', ?, 'test_mail', ?)`).run(new Date().toISOString(), actor.id, actor.name, ereignis.id, JSON.stringify({ status }));
}

export function createBenachrichtigungenRouter({ db, config, mailer, csrfProtection = (req, res, next) => next() }) {
  const router = Router();

  function renderSeite(req, res, status, ereignis, { werte = gespeicherteWerte(db, ereignis), errors = [] } = {}) {
    const vorschau = ereignis.vorlagenTyp
      ? renderBenachrichtigung(db, ereignis.vorlagenTyp, beispielVariablen(ereignis), { betreff: werte.betreff, text: werte.text })
      : null;
    const gespeicherteAuditAdressen = nurEmail(ereignis) ? auditAdressen(getConfigValue(db, ereignis.empfaengerKey)).adressen : [];
    const testmail = TESTMAIL_HINWEISE[req.query.testmail];
    const istZusammenfassung = ereignis.id === 'zusammenfassung';
    res.status(status).render('admin/benachrichtigungen', {
      bereiche: BEREICHE.map((name) => ({
        name,
        ereignisse: EREIGNISSE.filter((e) => e.bereich === name).map((e) => ({ id: e.id, titel: e.titel, angepasst: istAngepasst(db, e) })),
      })),
      ereignis,
      werte,
      errors,
      empfaengerListe: ereignis.empfaengerKey && !nurEmail(ereignis) ? empfaengerAnzeige(db, werte.empfaenger) : [],
      adminAdressen: adminAdressen(db, config, gespeicherteAuditAdressen),
      vorschau,
      angepasst: istAngepasst(db, ereignis),
      gespeichert: req.query.gespeichert === '1',
      zurueckgesetzt: req.query.zurueckgesetzt === '1',
      testmailHinweis: testmail ? { art: testmail.art, text: testmail.text(req.currentPerson?.email ?? '') } : null,
      standardWahl: STANDARD_WAHL,
      wochentagNamen: WOCHENTAG_NAMEN,
      digestLog: istZusammenfassung ? listRecentCronLog(db, 'mail-digest', DIGEST_LOG_LIMIT) : [],
      getriggert: istZusammenfassung && req.query.getriggert === '1',
      zurueckgestellt: istZusammenfassung ? Math.max(0, Number.parseInt(req.query.zurueckgestellt, 10) || 0) : 0,
    });
  }

  const nichtGefunden = (res) => res.status(404).render('error', { message: 'Dieses Ereignis gibt es nicht.' });

  router.get('/', (req, res) => res.redirect(`${BASIS}/${EREIGNISSE[0].id}`));

  router.get('/:id', (req, res) => {
    const ereignis = findeEreignis(req.params.id);
    if (!ereignis) return nichtGefunden(res);
    renderSeite(req, res, 200, ereignis);
  });

  router.post('/zusammenfassung/jetzt-ausfuehren', csrfProtection, asyncHandler(async (req, res) => {
    const ergebnis = await runMailDigestJob(db, config, mailer);
    const zurueck = ergebnis?.zurueckgestellt > 0 ? `&zurueckgestellt=${ergebnis.zurueckgestellt}` : '';
    res.redirect(`${BASIS}/zusammenfassung?getriggert=1${zurueck}`);
  }));

  router.post('/:id', csrfProtection, asyncHandler(async (req, res) => {
    const ereignis = findeEreignis(req.params.id);
    if (!ereignis) return nichtGefunden(res);
    const { errors, eingabe, speichern } = pruefeFormular(db, ereignis, req.body);
    if (errors.length > 0) return renderSeite(req, res, 400, ereignis, { werte: eingabe, errors });

    const vorlagenAenderungen = auditVorlagenAenderungen(db, ereignis, speichern);
    const alteAuditListe = nurEmail(ereignis) ? auditAdressen(getConfigValue(db, ereignis.empfaengerKey)).adressen.join(', ') : null;
    const alterStandard = getConfigValue(db, 'mail_standard_benachrichtigung');
    speichereWerte(db, speichern);

    // Standard neu "sofort": Wartendes aller Adressen, die nun sofort gelten, gleich zustellen.
    if (ereignis.id === 'zusammenfassung' && speichern.mail_standard_benachrichtigung === 'sofort' && alterStandard !== 'sofort') {
      for (const empfaenger of [...listGeplantMailsGruppiertNachEmpfaenger(db).keys()]) {
        if (benachrichtigungFuer(db, empfaenger) !== 'sofort') continue;
        try {
          await stelleWartendeSofortZu(db, config, mailer, empfaenger, { vorher: alterStandard });
        } catch (err) {
          console.error('Standard auf sofort: Zustellung wartender Mails fehlgeschlagen', err);
        }
      }
    }
    // Mails an die Revision sind Nebenwirkung: ein Mailfehler macht das Speichern nicht rückgängig.
    try {
      if (alteAuditListe !== null && speichern[ereignis.empfaengerKey] !== alteAuditListe) {
        await meldeAuditEmpfaengerWechsel(db, config, mailer, { alt: alteAuditListe, neu: speichern[ereignis.empfaengerKey], person: req.currentPerson });
      }
      if (vorlagenAenderungen.length > 0) {
        await meldeAuditNachweisAenderung(db, config, mailer, { aenderungen: vorlagenAenderungen, person: req.currentPerson });
      }
    } catch (err) {
      console.error('Audit-Nachweis: Änderungsmail fehlgeschlagen', err);
    }
    res.redirect(`${BASIS}/${ereignis.id}?gespeichert=1`);
  }));

  router.post('/:id/zuruecksetzen', csrfProtection, asyncHandler(async (req, res) => {
    const ereignis = findeEreignis(req.params.id);
    if (!ereignis?.vorlagenTyp) return nichtGefunden(res);
    const keys = vorlagenKeys(ereignis);
    const standard = { [keys.betreff]: DEFAULTS[keys.betreff], [keys.text]: DEFAULTS[keys.text] };
    const vorlagenAenderungen = auditVorlagenAenderungen(db, ereignis, standard);
    speichereWerte(db, standard);
    if (vorlagenAenderungen.length > 0) {
      try {
        await meldeAuditNachweisAenderung(db, config, mailer, { aenderungen: vorlagenAenderungen, person: req.currentPerson });
      } catch (err) {
        console.error('Audit-Nachweis: Änderungsmail fehlgeschlagen', err);
      }
    }
    res.redirect(`${BASIS}/${ereignis.id}?zurueckgesetzt=1`);
  }));

  // Rendert die gespeicherte Vorlage mit Beispieldaten und schickt sie über den normalen
  // Versandweg (sofort, nie gebündelt) an die angemeldete Person.
  router.post('/:id/test-mail', csrfProtection, asyncHandler(async (req, res) => {
    const ereignis = findeEreignis(req.params.id);
    if (!ereignis?.vorlagenTyp) return nichtGefunden(res);
    const to = (req.currentPerson?.email ?? '').trim();
    let status = 'keine-adresse';
    if (to) {
      const { subject, text } = renderBenachrichtigung(db, ereignis.vorlagenTyp, beispielVariablen(ereignis));
      ({ status } = await sendRenderedMail(db, mailer, { to, subject: `[Test] ${subject}`, text, typ: 'testmail', jobId: null }));
    }
    schreibeTestmailAudit(db, ereignis, status);
    res.redirect(`${BASIS}/${ereignis.id}?testmail=${status}`);
  }));

  return router;
}
