import { Router } from 'express';
import { getConfigValue, setConfigValue } from '../../db/adminConfigRepo.js';
import { listRecentCronLog } from '../../db/cronLogRepo.js';
import { runMailDigestJob } from '../../services/cronJobs.js';

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
      batchingAktiv: getConfigValue(db, 'mail_batching_aktiv') === '1',
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
      gespeichert: req.query.gespeichert === '1',
    });
  });

  router.post('/', csrfProtection, (req, res) => {
    const errors = [];
    const felder = {};
    for (const [feldName] of VORLAGEN_FELDER) {
      const wert = (req.body[feldName] || '').trim();
      if (!wert) {
        errors.push(`${feldName} darf nicht leer sein.`);
      }
      felder[feldName] = wert;
    }

    const batchingAktiv = req.body.batchingAktiv === '1';
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
        batchingAktiv,
        batchingStunde: req.body.batchingStunde,
        batchingMinute: req.body.batchingMinute,
        digestLog: listRecentCronLog(db, 'mail-digest', LOG_LIMIT),
        getriggert: null,
        errors,
        gespeichert: false,
      });
    }

    for (const [feldName, configKey] of VORLAGEN_FELDER) {
      setConfigValue(db, configKey, felder[feldName]);
    }
    setConfigValue(db, 'mail_batching_aktiv', batchingAktiv ? '1' : '0');
    setConfigValue(db, 'mail_batching_stunde', String(batchingStundeNum));
    setConfigValue(db, 'mail_batching_minute', String(batchingMinuteNum));
    res.redirect('/admin/mail-einstellungen?gespeichert=1');
  });

  router.post('/jetzt-ausfuehren', csrfProtection, async (req, res, next) => {
    try {
      await runMailDigestJob(db, config, mailer);
      res.redirect('/admin/mail-einstellungen?getriggert=1');
    } catch (err) {
      next(err);
    }
  });

  return router;
}
