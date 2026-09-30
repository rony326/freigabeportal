import { Router } from 'express';
import { getConfigValue, setConfigValue } from '../../db/adminConfigRepo.js';
import { listRecentSyncLogs } from '../../db/syncLogRepo.js';
import { listRecentCronLog } from '../../db/cronLogRepo.js';
import { runSyncPersonenJob, runPoolErinnerungenJob, runPdfBereinigungJob, runZeitstempelNachholenJob, runSplitGruppenNachholenJob, runFreigabe2ErinnerungenJob, runKkBelegErinnerungenJob, runMailZustellungJob } from '../../services/cronJobs.js';

const LOG_LIMIT = 10;

export function createGeplanteJobsRouter({ db, config, mailer, csrfProtection = (req, res, next) => next() }) {
  const router = Router();

  function ladeState(getriggert) {
    return {
      cronSyncPersonenStunde: getConfigValue(db, 'cron_sync_personen_stunde'),
      cronSyncPersonenMinute: getConfigValue(db, 'cron_sync_personen_minute'),
      cronPoolErinnerungenIntervallMinuten: getConfigValue(db, 'cron_pool_erinnerungen_intervall_minuten'),
      cronPdfBereinigungStunde: getConfigValue(db, 'cron_pdf_bereinigung_stunde'),
      cronPdfBereinigungMinute: getConfigValue(db, 'cron_pdf_bereinigung_minute'),
      kkBelegVerworfenLoeschenTage: getConfigValue(db, 'kk_beleg_verworfen_loeschen_tage'),
      cronZeitstempelNachholenIntervallMinuten: getConfigValue(db, 'cron_zeitstempel_nachholen_intervall_minuten'),
      cronSplitGruppenNachholenIntervallMinuten: getConfigValue(db, 'cron_split_gruppen_nachholen_intervall_minuten'),
      cronFreigabe2ErinnerungenIntervallMinuten: getConfigValue(db, 'cron_freigabe2_erinnerungen_intervall_minuten'),
      kkBelegErinnerungenAktiv: getConfigValue(db, 'kk_beleg_erinnerungen_aktiv') === '1',
      kkBelegErinnerungTage: getConfigValue(db, 'kk_beleg_erinnerung_tage'),
      cronKkBelegErinnerungenStunde: getConfigValue(db, 'cron_kk_beleg_erinnerungen_stunde'),
      cronKkBelegErinnerungenMinute: getConfigValue(db, 'cron_kk_beleg_erinnerungen_minute'),
      syncLog: listRecentSyncLogs(db, LOG_LIMIT),
      poolErinnerungenLog: listRecentCronLog(db, 'pool-erinnerungen', LOG_LIMIT),
      pdfBereinigungLog: listRecentCronLog(db, 'pdf-bereinigung', LOG_LIMIT),
      zeitstempelNachholenLog: listRecentCronLog(db, 'zeitstempel-nachholen', LOG_LIMIT),
      splitGruppenNachholenLog: listRecentCronLog(db, 'split-gruppen-nachholen', LOG_LIMIT),
      freigabe2ErinnerungenLog: listRecentCronLog(db, 'freigabe2-erinnerungen', LOG_LIMIT),
      kkBelegErinnerungenLog: listRecentCronLog(db, 'kk-beleg-erinnerungen', LOG_LIMIT),
      cronMailZustellungIntervallMinuten: getConfigValue(db, 'cron_mail_zustellung_intervall_minuten'),
      mailZustellungLog: listRecentCronLog(db, 'mail-zustellung', LOG_LIMIT),
      getriggert,
    };
  }

  router.get('/', (req, res) => {
    res.render('admin/geplante-jobs', {
      ...ladeState(req.query.getriggert || null),
      errors: [],
      gespeichert: req.query.gespeichert === '1',
    });
  });

  router.post('/', csrfProtection, (req, res) => {
    const {
      syncPersonenStunde,
      syncPersonenMinute,
      poolErinnerungenIntervallMinuten,
      pdfBereinigungStunde,
      pdfBereinigungMinute,
      kkBelegVerworfenLoeschenTage,
      zeitstempelNachholenIntervallMinuten,
      splitGruppenNachholenIntervallMinuten,
      freigabe2ErinnerungenIntervallMinuten,
      kkBelegErinnerungenAktiv,
      kkBelegErinnerungTage,
      kkBelegErinnerungenStunde,
      kkBelegErinnerungenMinute,
      mailZustellungIntervallMinuten,
    } = req.body;
    const errors = [];

    function ganzzahlImBereich(wert, min, max, label) {
      const num = Number(wert);
      if (!Number.isInteger(num) || num < min || num > max) {
        errors.push(`${label} muss eine Ganzzahl zwischen ${min} und ${max} sein.`);
      }
      return num;
    }

    const syncStundeNum = ganzzahlImBereich(syncPersonenStunde, 0, 23, 'Personen-Sync: Stunde');
    const syncMinuteNum = ganzzahlImBereich(syncPersonenMinute, 0, 59, 'Personen-Sync: Minute');
    const pdfStundeNum = ganzzahlImBereich(pdfBereinigungStunde, 0, 23, 'PDF-Bereinigung: Stunde');
    const pdfMinuteNum = ganzzahlImBereich(pdfBereinigungMinute, 0, 59, 'PDF-Bereinigung: Minute');
    const kkBelegVerworfenLoeschenTageNum = ganzzahlImBereich(kkBelegVerworfenLoeschenTage, 1, 3650, 'Verworfene Kreditkartenbelege: Tage');
    const intervallNum = Number(poolErinnerungenIntervallMinuten);
    if (!Number.isInteger(intervallNum) || intervallNum <= 0) {
      errors.push('Pool-Erinnerungen: Intervall muss eine positive Ganzzahl (Minuten) sein.');
    }
    const zeitstempelIntervallNum = Number(zeitstempelNachholenIntervallMinuten);
    if (!Number.isInteger(zeitstempelIntervallNum) || zeitstempelIntervallNum <= 0) {
      errors.push('Zeitstempel-Nachholen: Intervall muss eine positive Ganzzahl (Minuten) sein.');
    }
    const splitGruppenNachholenIntervallNum = Number(splitGruppenNachholenIntervallMinuten);
    if (!Number.isInteger(splitGruppenNachholenIntervallNum) || splitGruppenNachholenIntervallNum <= 0) {
      errors.push('Splitgruppen-Nachholen: Intervall muss eine positive Ganzzahl (Minuten) sein.');
    }
    const freigabe2ErinnerungenIntervallNum = Number(freigabe2ErinnerungenIntervallMinuten);
    if (!Number.isInteger(freigabe2ErinnerungenIntervallNum) || freigabe2ErinnerungenIntervallNum <= 0) {
      errors.push('Freigabe2-Erinnerungen: Intervall muss eine positive Ganzzahl (Minuten) sein.');
    }
    const kkBelegErinnerungTageNum = ganzzahlImBereich(kkBelegErinnerungTage, 1, 365, 'Kreditkartenbelege: Tage');
    const kkBelegErinnerungenStundeNum = ganzzahlImBereich(kkBelegErinnerungenStunde, 0, 23, 'Kreditkartenbelege-Erinnerungen: Stunde');
    const kkBelegErinnerungenMinuteNum = ganzzahlImBereich(kkBelegErinnerungenMinute, 0, 59, 'Kreditkartenbelege-Erinnerungen: Minute');
    const kkBelegErinnerungenAktivBool = kkBelegErinnerungenAktiv === '1';
    // Ältere, vor diesem Feld geladene Formulare senden es nicht: dann bleibt der gespeicherte Wert.
    const mailZustellungIntervallRoh = mailZustellungIntervallMinuten ?? getConfigValue(db, 'cron_mail_zustellung_intervall_minuten') ?? '5';
    const mailZustellungIntervallNum = ganzzahlImBereich(mailZustellungIntervallRoh, 1, 1440, 'Mail-Zustellung: Intervall (Minuten)');

    if (errors.length > 0) {
      return res.status(400).render('admin/geplante-jobs', {
        cronSyncPersonenStunde: syncPersonenStunde,
        cronSyncPersonenMinute: syncPersonenMinute,
        cronPoolErinnerungenIntervallMinuten: poolErinnerungenIntervallMinuten,
        cronPdfBereinigungStunde: pdfBereinigungStunde,
        cronPdfBereinigungMinute: pdfBereinigungMinute,
        kkBelegVerworfenLoeschenTage,
        cronZeitstempelNachholenIntervallMinuten: zeitstempelNachholenIntervallMinuten,
        cronSplitGruppenNachholenIntervallMinuten: splitGruppenNachholenIntervallMinuten,
        cronFreigabe2ErinnerungenIntervallMinuten: freigabe2ErinnerungenIntervallMinuten,
        kkBelegErinnerungenAktiv: kkBelegErinnerungenAktivBool,
        kkBelegErinnerungTage,
        cronKkBelegErinnerungenStunde: kkBelegErinnerungenStunde,
        cronKkBelegErinnerungenMinute: kkBelegErinnerungenMinute,
        syncLog: listRecentSyncLogs(db, LOG_LIMIT),
        poolErinnerungenLog: listRecentCronLog(db, 'pool-erinnerungen', LOG_LIMIT),
        pdfBereinigungLog: listRecentCronLog(db, 'pdf-bereinigung', LOG_LIMIT),
        zeitstempelNachholenLog: listRecentCronLog(db, 'zeitstempel-nachholen', LOG_LIMIT),
        splitGruppenNachholenLog: listRecentCronLog(db, 'split-gruppen-nachholen', LOG_LIMIT),
        freigabe2ErinnerungenLog: listRecentCronLog(db, 'freigabe2-erinnerungen', LOG_LIMIT),
        kkBelegErinnerungenLog: listRecentCronLog(db, 'kk-beleg-erinnerungen', LOG_LIMIT),
        cronMailZustellungIntervallMinuten: mailZustellungIntervallRoh,
        mailZustellungLog: listRecentCronLog(db, 'mail-zustellung', LOG_LIMIT),
        getriggert: null,
        errors,
        gespeichert: false,
      });
    }

    setConfigValue(db, 'cron_sync_personen_stunde', String(syncStundeNum));
    setConfigValue(db, 'cron_sync_personen_minute', String(syncMinuteNum));
    setConfigValue(db, 'cron_pool_erinnerungen_intervall_minuten', String(intervallNum));
    setConfigValue(db, 'cron_pdf_bereinigung_stunde', String(pdfStundeNum));
    setConfigValue(db, 'cron_pdf_bereinigung_minute', String(pdfMinuteNum));
    setConfigValue(db, 'kk_beleg_verworfen_loeschen_tage', String(kkBelegVerworfenLoeschenTageNum));
    setConfigValue(db, 'cron_zeitstempel_nachholen_intervall_minuten', String(zeitstempelIntervallNum));
    setConfigValue(db, 'cron_split_gruppen_nachholen_intervall_minuten', String(splitGruppenNachholenIntervallNum));
    setConfigValue(db, 'cron_freigabe2_erinnerungen_intervall_minuten', String(freigabe2ErinnerungenIntervallNum));
    setConfigValue(db, 'kk_beleg_erinnerungen_aktiv', kkBelegErinnerungenAktivBool ? '1' : '0');
    setConfigValue(db, 'kk_beleg_erinnerung_tage', String(kkBelegErinnerungTageNum));
    setConfigValue(db, 'cron_kk_beleg_erinnerungen_stunde', String(kkBelegErinnerungenStundeNum));
    setConfigValue(db, 'cron_kk_beleg_erinnerungen_minute', String(kkBelegErinnerungenMinuteNum));
    setConfigValue(db, 'cron_mail_zustellung_intervall_minuten', String(mailZustellungIntervallNum));
    res.redirect('/admin/geplante-jobs?gespeichert=1');
  });

  // Manual/on-demand triggers, reusing the exact same job functions the in-process scheduler
  // calls (services/cronJobs.js) — same behavior, same logging (cron_log/sync_log), just fired
  // by an admin click instead of a timer. Each run is already persisted before the redirect, so
  // the GET handler picks the just-created row straight back up as feedback (no separate flash
  // mechanism needed).
  router.post('/sync-personen/jetzt-ausfuehren', csrfProtection, async (req, res, next) => {
    try {
      await runSyncPersonenJob(db, config, mailer);
      res.redirect('/admin/geplante-jobs?getriggert=sync-personen');
    } catch (err) {
      next(err);
    }
  });

  router.post('/pool-erinnerungen/jetzt-ausfuehren', csrfProtection, async (req, res, next) => {
    try {
      await runPoolErinnerungenJob(db, config, mailer);
      res.redirect('/admin/geplante-jobs?getriggert=pool-erinnerungen');
    } catch (err) {
      next(err);
    }
  });

  router.post('/pdf-bereinigung/jetzt-ausfuehren', csrfProtection, (req, res, next) => {
    try {
      runPdfBereinigungJob(db, config);
      res.redirect('/admin/geplante-jobs?getriggert=pdf-bereinigung');
    } catch (err) {
      next(err);
    }
  });

  router.post('/zeitstempel-nachholen/jetzt-ausfuehren', csrfProtection, async (req, res, next) => {
    try {
      await runZeitstempelNachholenJob(db, config);
      res.redirect('/admin/geplante-jobs?getriggert=zeitstempel-nachholen');
    } catch (err) {
      next(err);
    }
  });

  router.post('/split-gruppen-nachholen/jetzt-ausfuehren', csrfProtection, async (req, res, next) => {
    try {
      await runSplitGruppenNachholenJob(db, config);
      res.redirect('/admin/geplante-jobs?getriggert=split-gruppen-nachholen');
    } catch (err) {
      next(err);
    }
  });

  router.post('/freigabe2-erinnerungen/jetzt-ausfuehren', csrfProtection, async (req, res, next) => {
    try {
      await runFreigabe2ErinnerungenJob(db, config, mailer);
      res.redirect('/admin/geplante-jobs?getriggert=freigabe2-erinnerungen');
    } catch (err) {
      next(err);
    }
  });

  router.post('/kk-beleg-erinnerungen/jetzt-ausfuehren', csrfProtection, async (req, res, next) => {
    try {
      await runKkBelegErinnerungenJob(db, config, mailer);
      res.redirect('/admin/geplante-jobs?getriggert=kk-beleg-erinnerungen');
    } catch (err) {
      next(err);
    }
  });

  router.post('/mail-zustellung/jetzt-ausfuehren', csrfProtection, async (req, res, next) => {
    try {
      await runMailZustellungJob(db, config, mailer);
      res.redirect('/admin/geplante-jobs?getriggert=mail-zustellung');
    } catch (err) {
      next(err);
    }
  });

  return router;
}
