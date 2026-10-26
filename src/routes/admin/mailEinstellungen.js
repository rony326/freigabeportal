import { Router } from 'express';
import { getConfigValue, setConfigValue } from '../../db/adminConfigRepo.js';
import { listRecentCronLog } from '../../db/cronLogRepo.js';
import { runMailDigestJob } from '../../services/cronJobs.js';
import { BENACHRICHTIGUNG_WERTE, WOCHENTAG_NAMEN, standardBenachrichtigung, digestWochentag } from '../../services/benachrichtigung.js';
import { meldeAuditNachweisAenderung } from '../../services/auditNachweisJobs.js';

const LOG_LIMIT = 10;

const VORLAGEN_FELDER = [
  ['zuweisungBetreff', 'mail_vorlage_zuweisung_betreff'],
  ['zuweisungText', 'mail_vorlage_zuweisung_text'],
  ['reminderBetreff', 'mail_vorlage_reminder_betreff'],
  ['reminderText', 'mail_vorlage_reminder_text'],
  ['eskalationBetreff', 'mail_vorlage_eskalation_betreff'],
  ['eskalationText', 'mail_vorlage_eskalation_text'],
  ['ablehnungBetreff', 'mail_vorlage_ablehnung_betreff'],
  ['ablehnungText', 'mail_vorlage_ablehnung_text'],
  ['syncFehlerBetreff', 'mail_vorlage_sync_fehler_betreff'],
  ['syncFehlerText', 'mail_vorlage_sync_fehler_text'],
  ['ibanWarnungBetreff', 'mail_vorlage_iban_warnung_betreff'],
  ['ibanWarnungText', 'mail_vorlage_iban_warnung_text'],
  ['rechnungsnummerWarnungBetreff', 'mail_vorlage_rechnungsnummer_warnung_betreff'],
  ['rechnungsnummerWarnungText', 'mail_vorlage_rechnungsnummer_warnung_text'],
  ['digestBetreff', 'mail_vorlage_digest_betreff'],
  ['digestText', 'mail_vorlage_digest_text'],
  ['freigabe2ReminderBetreff', 'mail_vorlage_freigabe2_reminder_betreff'],
  ['freigabe2ReminderText', 'mail_vorlage_freigabe2_reminder_text'],
  ['freigabe2EskalationBetreff', 'mail_vorlage_freigabe2_eskalation_betreff'],
  ['freigabe2EskalationText', 'mail_vorlage_freigabe2_eskalation_text'],
  ['kkAbrechnungZugewiesenBetreff', 'mail_vorlage_kk_abrechnung_zugewiesen_betreff'],
  ['kkAbrechnungZugewiesenText', 'mail_vorlage_kk_abrechnung_zugewiesen_text'],
  ['kkBelegErinnerungBetreff', 'mail_vorlage_kk_beleg_erinnerung_betreff'],
  ['kkBelegErinnerungText', 'mail_vorlage_kk_beleg_erinnerung_text'],
  ['kkBelegEingegangenBetreff', 'mail_vorlage_kk_beleg_eingegangen_betreff'],
  ['kkBelegEingegangenText', 'mail_vorlage_kk_beleg_eingegangen_text'],
  ['adminUmzuweisungBetreff', 'mail_vorlage_admin_umzuweisung_betreff'],
  ['adminUmzuweisungText', 'mail_vorlage_admin_umzuweisung_text'],
  ['duplikatWarnungBetreff', 'mail_vorlage_duplikat_warnung_betreff'],
  ['duplikatWarnungText', 'mail_vorlage_duplikat_warnung_text'],
  ['auditPruefnummerBetreff', 'mail_vorlage_audit_pruefnummer_betreff'],
  ['auditPruefnummerText', 'mail_vorlage_audit_pruefnummer_text'],
  ['neuesGeraetBetreff', 'mail_vorlage_neues_geraet_betreff'],
  ['neuesGeraetText', 'mail_vorlage_neues_geraet_text'],
  ['fehlermeldungBetreff', 'mail_vorlage_fehlermeldung_betreff'],
  ['fehlermeldungText', 'mail_vorlage_fehlermeldung_text'],
  ['kommentarBetreff', 'mail_vorlage_kommentar_betreff'],
  ['kommentarText', 'mail_vorlage_kommentar_text'],
];

export function createMailEinstellungenRouter({ db, config, mailer, csrfProtection = (req, res, next) => next() }) {
  const router = Router();

  function ladeState(getriggert) {
    const felder = {};
    for (const [feldName, configKey] of VORLAGEN_FELDER) {
      felder[feldName] = getConfigValue(db, configKey);
    }
    return {
      ...felder,
      standardBenachrichtigung: standardBenachrichtigung(db),
      digestWochentag: digestWochentag(db),
      wochentagNamen: WOCHENTAG_NAMEN,
      zurueckgestellt: 0,
      batchingStunde: getConfigValue(db, 'mail_batching_stunde'),
      batchingMinute: getConfigValue(db, 'mail_batching_minute'),
      digestLog: listRecentCronLog(db, 'mail-digest', LOG_LIMIT),
      getriggert,
    };
  }

  router.get('/', (req, res) => {
    res.render('admin/mail-einstellungen-form', {
      ...ladeState(req.query.getriggert || null),
      errors: [],
      zurueckgestellt: Math.max(0, Number.parseInt(req.query.zurueckgestellt, 10) || 0),
      gespeichert: req.query.gespeichert === '1',
    });
  });

  router.post('/', csrfProtection, async (req, res) => {
    const errors = [];
    const felder = {};
    for (const [feldName] of VORLAGEN_FELDER) {
      const wert = (req.body[feldName] || '').trim();
      if (!wert) {
        errors.push(`${feldName} darf nicht leer sein.`);
      }
      felder[feldName] = wert;
    }

    const standardWahl = req.body.standardBenachrichtigung;
    const wochentagNum = Number(req.body.digestWochentag);
    if (!BENACHRICHTIGUNG_WERTE.includes(standardWahl)) {
      errors.push('Standard-Bündelung muss sofort, täglich oder wöchentlich sein.');
    }
    if (!Number.isInteger(wochentagNum) || wochentagNum < 1 || wochentagNum > 7) {
      errors.push('Wochentag muss zwischen Montag und Sonntag liegen.');
    }
    const batchingStundeNum = Number(req.body.batchingStunde);
    const batchingMinuteNum = Number(req.body.batchingMinute);
    if (!Number.isInteger(batchingStundeNum) || batchingStundeNum < 0 || batchingStundeNum > 23) {
      errors.push('Uhrzeit (Stunde) muss eine Ganzzahl zwischen 0 und 23 sein.');
    }
    if (!Number.isInteger(batchingMinuteNum) || batchingMinuteNum < 0 || batchingMinuteNum > 59) {
      errors.push('Uhrzeit (Minute) muss eine Ganzzahl zwischen 0 und 59 sein.');
    }

    if (errors.length > 0) {
      return res.status(400).render('admin/mail-einstellungen-form', {
        ...felder,
        standardBenachrichtigung: standardWahl,
        digestWochentag: wochentagNum,
        wochentagNamen: WOCHENTAG_NAMEN,
        zurueckgestellt: 0,
        batchingStunde: req.body.batchingStunde,
        batchingMinute: req.body.batchingMinute,
        digestLog: listRecentCronLog(db, 'mail-digest', LOG_LIMIT),
        getriggert: null,
        errors,
        gespeichert: false,
      });
    }

    const aenderungen = [];
    if (getConfigValue(db, 'mail_vorlage_audit_pruefnummer_betreff') !== felder.auditPruefnummerBetreff) {
      aenderungen.push('Betreff der Prüfnummer-Mail wurde geändert');
    }
    if (getConfigValue(db, 'mail_vorlage_audit_pruefnummer_text') !== felder.auditPruefnummerText) {
      aenderungen.push('Text der Prüfnummer-Mail wurde geändert');
    }
    for (const [feldName, configKey] of VORLAGEN_FELDER) {
      setConfigValue(db, configKey, felder[feldName]);
    }
    setConfigValue(db, 'mail_standard_benachrichtigung', standardWahl);
    setConfigValue(db, 'mail_digest_wochentag', String(wochentagNum));
    setConfigValue(db, 'mail_batching_stunde', String(batchingStundeNum));
    setConfigValue(db, 'mail_batching_minute', String(batchingMinuteNum));
    // Mail ist Nebenwirkung: ein Mailfehler macht das Speichern nicht rückgängig.
    if (aenderungen.length > 0) {
      try {
        await meldeAuditNachweisAenderung(db, config, mailer, { aenderungen, person: req.currentPerson });
      } catch (err) {
        console.error('Audit-Nachweis: Änderungsmail fehlgeschlagen', err);
      }
    }
    res.redirect('/admin/mail-einstellungen?gespeichert=1');
  });

  router.post('/jetzt-ausfuehren', csrfProtection, async (req, res, next) => {
    try {
      const ergebnis = await runMailDigestJob(db, config, mailer);
      const zurueck = ergebnis?.zurueckgestellt > 0 ? `&zurueckgestellt=${ergebnis.zurueckgestellt}` : '';
      res.redirect(`/admin/mail-einstellungen?getriggert=1${zurueck}`);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
