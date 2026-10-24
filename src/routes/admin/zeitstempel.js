import { Router } from 'express';
import { getConfigValue, setConfigValue } from '../../db/adminConfigRepo.js';
import { listActivePersonsInGroup } from '../../db/personenRepo.js';
import {
  parseEmpfaengerListe, sendeAuditPruefnummer, meldeAuditEmpfaengerWechsel,
  meldeAuditNachweisAenderung, listPaketeOhneZeitstempel,
} from '../../services/auditNachweisJobs.js';

const URL_PATTERN = /^https?:\/\//;
const RHYTHMEN = { monatlich: 'monatlich', quartalsweise: 'quartalsweise', jaehrlich: 'jährlich' };

// Formularfeld -> [Config-Key, Standardwert, Min, Max, Label]
const ZAHLENFELDER = {
  auditPruefnummerTag: ['audit_pruefnummer_tag', '1', 1, 28, 'Versandtag'],
  auditExportStunde: ['cron_audit_export_stunde', '3', 0, 23, 'Nächtlicher Export: Stunde'],
  auditExportMinute: ['cron_audit_export_minute', '15', 0, 59, 'Nächtlicher Export: Minute'],
  auditPruefnummerStunde: ['cron_audit_pruefnummer_stunde', '7', 0, 23, 'Versand der Prüfnummer: Stunde'],
  auditPruefnummerMinute: ['cron_audit_pruefnummer_minute', '0', 0, 59, 'Versand der Prüfnummer: Minute'],
  auditZeitstempelAlarmTage: ['audit_zeitstempel_alarm_tage', '3', 1, 30, 'Alarm ab (Tage ohne Zeitstempel)'],
};

const VERSAND_HINWEISE = {
  versendet: { art: 'success', text: 'Die Prüfnummer wurde versendet.' },
  kein_empfaenger: { art: 'warning', text: 'Nichts versendet: kein Empfänger festgelegt.' },
  kein_paket: { art: 'warning', text: 'Nichts versendet: es existiert noch kein Audit-Paket.' },
};

export function createZeitstempelAdminRouter({ db, config = null, mailer = null, csrfProtection = (req, res, next) => next() }) {
  const router = Router();

  function auditState() {
    const werte = {
      auditRevisionEmpfaenger: getConfigValue(db, 'audit_revision_empfaenger') ?? '',
      auditNachweisAktiv: getConfigValue(db, 'modul_audit_nachweis_aktiv') === '1',
      auditPruefnummerRhythmus: getConfigValue(db, 'audit_pruefnummer_rhythmus') ?? 'monatlich',
    };
    for (const [feld, [key, standard]] of Object.entries(ZAHLENFELDER)) werte[feld] = getConfigValue(db, key) ?? standard;
    return werte;
  }

  // Adressen, die einer aktiven Person mit Admin-Rechten gehören (Revision soll unabhängig sein).
  function adminAdressen(adressen) {
    const groupId = config?.churchtools?.groupIdAdmin;
    if (!groupId) return [];
    const adminMails = new Set(listActivePersonsInGroup(db, groupId).map((p) => (p.email ?? '').toLowerCase()).filter(Boolean));
    return adressen.filter((a) => adminMails.has(a.toLowerCase()));
  }

  function currentState() {
    return {
      tsaUrl: getConfigValue(db, 'zeitstempel_tsa_url') ?? '',
      tsaUser: getConfigValue(db, 'zeitstempel_tsa_user') ?? '',
      warnungAbStunden: getConfigValue(db, 'zeitstempel_warnung_ab_stunden') ?? '',
      ...auditState(),
    };
  }

  function renderSeite(res, status, state, { errors = [], gespeichert = false, versand = null } = {}) {
    const { adressen } = parseEmpfaengerListe(state.auditRevisionEmpfaenger);
    res.status(status).render('admin/zeitstempel-form', {
      ...state,
      errors,
      gespeichert,
      rhythmen: RHYTHMEN,
      versandHinweis: VERSAND_HINWEISE[versand] ?? null,
      adminAdressen: adminAdressen(adressen),
      empfaengerFehlt: adressen.length === 0,
      letztesPaket: db.prepare('SELECT * FROM audit_export_pakete ORDER BY id DESC LIMIT 1').get() ?? null,
      paketeOhneZeitstempel: listPaketeOhneZeitstempel(db).length,
    });
  }

  router.get('/', (req, res) => {
    renderSeite(res, 200, currentState(), { gespeichert: req.query.gespeichert === '1', versand: req.query.versand });
  });

  router.post('/', csrfProtection, async (req, res) => {
    const { tsaUrl, tsaUser, tsaPasswort, warnungAbStunden } = req.body;
    const trimmedUrl = (tsaUrl || '').trim();
    const trimmedUser = (tsaUser || '').trim();
    const trimmedWarnung = (warnungAbStunden || '').trim();
    const errors = [];
    if (trimmedUrl && !URL_PATTERN.test(trimmedUrl)) {
      errors.push('TSA-URL muss leer sein (Funktion deaktiviert) oder mit http:// oder https:// beginnen.');
    }
    if (!/^[1-9][0-9]*$/.test(trimmedWarnung)) {
      errors.push('Warnschwelle (Stunden) muss eine ganze Zahl grösser als 0 sein.');
    }

    // Audit-Felder nur auswerten, wenn das Formular sie mitsendet (Marker auditFormular):
    // alte Posts ohne diese Felder lassen die Audit-Einstellungen unverändert, und eine fehlende
    // Checkbox heisst sonst "abgeschaltet".
    const aktuell = auditState();
    const audit = { ...aktuell };
    if (req.body.auditFormular === '1') {
      audit.auditRevisionEmpfaenger = String(req.body.auditRevisionEmpfaenger ?? '').trim();
      audit.auditNachweisAktiv = req.body.auditNachweisAktiv === '1';
      audit.auditPruefnummerRhythmus = String(req.body.auditPruefnummerRhythmus ?? '');
      for (const feld of Object.keys(ZAHLENFELDER)) audit[feld] = String(req.body[feld] ?? '').trim();
    }
    const { adressen, ungueltig } = parseEmpfaengerListe(audit.auditRevisionEmpfaenger);
    if (ungueltig.length > 0) errors.push(`Ungültige Mailadresse: ${ungueltig.join(', ')}.`);
    if (!Object.hasOwn(RHYTHMEN, audit.auditPruefnummerRhythmus)) {
      errors.push('Versandrhythmus muss monatlich, quartalsweise oder jährlich sein.');
    }
    for (const [feld, [, , min, max, label]] of Object.entries(ZAHLENFELDER)) {
      const wert = audit[feld];
      if (!/^\d+$/.test(String(wert)) || Number(wert) < min || Number(wert) > max) {
        errors.push(`${label} muss eine Ganzzahl zwischen ${min} und ${max} sein.`);
      }
    }

    if (errors.length > 0) {
      return renderSeite(res, 400, { tsaUrl: trimmedUrl, tsaUser: trimmedUser, warnungAbStunden: trimmedWarnung, ...audit }, { errors });
    }

    setConfigValue(db, 'zeitstempel_tsa_url', trimmedUrl);
    setConfigValue(db, 'zeitstempel_tsa_user', trimmedUser);
    // Leeres Feld behält das gespeicherte Passwort; nur die Checkbox löscht es.
    if (req.body.tsaPasswortEntfernen === '1') setConfigValue(db, 'zeitstempel_tsa_passwort', '');
    else if (tsaPasswort) setConfigValue(db, 'zeitstempel_tsa_passwort', tsaPasswort);
    setConfigValue(db, 'zeitstempel_warnung_ab_stunden', trimmedWarnung);

    // Normalisierte Liste speichern (ohne Duplikate/Leerzeichen).
    const neueListe = adressen.join(', ');
    const alteListe = parseEmpfaengerListe(aktuell.auditRevisionEmpfaenger).adressen.join(', ');
    setConfigValue(db, 'audit_revision_empfaenger', neueListe);
    setConfigValue(db, 'modul_audit_nachweis_aktiv', audit.auditNachweisAktiv ? '1' : '0');
    setConfigValue(db, 'audit_pruefnummer_rhythmus', audit.auditPruefnummerRhythmus);
    for (const [feld, [key]] of Object.entries(ZAHLENFELDER)) setConfigValue(db, key, String(Number(audit[feld])));

    const aenderungen = [];
    if (aktuell.auditNachweisAktiv !== audit.auditNachweisAktiv) {
      aenderungen.push(`Automatischer Nachweis: ${aktuell.auditNachweisAktiv ? 'aktiv' : 'abgeschaltet'} → ${audit.auditNachweisAktiv ? 'aktiv' : 'abgeschaltet'}`);
    }
    if (aktuell.auditPruefnummerRhythmus !== audit.auditPruefnummerRhythmus) {
      aenderungen.push(`Versandrhythmus: ${aktuell.auditPruefnummerRhythmus} → ${audit.auditPruefnummerRhythmus}`);
    }
    if (String(Number(aktuell.auditPruefnummerTag)) !== String(Number(audit.auditPruefnummerTag))) {
      aenderungen.push(`Versandtag: ${aktuell.auditPruefnummerTag} → ${Number(audit.auditPruefnummerTag)}`);
    }
    // Mails sind Nebenwirkung: ein Mailfehler macht das gespeicherte Ergebnis nicht rückgängig.
    try {
      if (neueListe !== alteListe) {
        await meldeAuditEmpfaengerWechsel(db, config, mailer, { alt: alteListe, neu: neueListe, person: req.currentPerson });
      }
      if (aenderungen.length > 0) {
        await meldeAuditNachweisAenderung(db, config, mailer, { aenderungen, person: req.currentPerson, zusaetzlicheEmpfaenger: parseEmpfaengerListe(alteListe).adressen });
      }
    } catch (err) {
      console.error('Audit-Nachweis: Änderungsmail fehlgeschlagen', err);
    }
    res.redirect('/admin/zeitstempel?gespeichert=1');
  });

  router.post('/audit-pruefnummer-senden', csrfProtection, async (req, res) => {
    let status;
    try {
      ({ status } = await sendeAuditPruefnummer(db, config, mailer));
    } catch (err) {
      console.error('Audit-Prüfnummer: manueller Versand fehlgeschlagen', err);
      return res.status(500).render('error', { message: 'Der Versand der Prüfnummer ist fehlgeschlagen.' });
    }
    res.redirect(`/admin/zeitstempel?versand=${status}`);
  });

  return router;
}
