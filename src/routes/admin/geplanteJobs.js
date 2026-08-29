import { Router } from 'express';
import { getConfigValue, setConfigValue } from '../../db/adminConfigRepo.js';
import { listRecentSyncLogs } from '../../db/syncLogRepo.js';
import { listRecentCronLog } from '../../db/cronLogRepo.js';
import { runSyncPersonenJob, runPoolErinnerungenJob, runPdfBereinigungJob, runZeitstempelNachholenJob } from '../../services/cronJobs.js';

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
      cronZeitstempelNachholenIntervallMinuten: getConfigValue(db, 'cron_zeitstempel_nachholen_intervall_minuten'),
      syncLog: listRecentSyncLogs(db, LOG_LIMIT),
      poolErinnerungenLog: listRecentCronLog(db, 'pool-erinnerungen', LOG_LIMIT),
      pdfBereinigungLog: listRecentCronLog(db, 'pdf-bereinigung', LOG_LIMIT),
      zeitstempelNachholenLog: listRecentCronLog(db, 'zeitstempel-nachholen', LOG_LIMIT),
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
      zeitstempelNachholenIntervallMinuten,
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
    const intervallNum = Number(poolErinnerungenIntervallMinuten);
    if (!Number.isInteger(intervallNum) || intervallNum <= 0) {
      errors.push('Pool-Erinnerungen: Intervall muss eine positive Ganzzahl (Minuten) sein.');
    }
    const zeitstempelIntervallNum = Number(zeitstempelNachholenIntervallMinuten);
    if (!Number.isInteger(zeitstempelIntervallNum) || zeitstempelIntervallNum <= 0) {
      errors.push('Zeitstempel-Nachholen: Intervall muss eine positive Ganzzahl (Minuten) sein.');
    }

    if (errors.length > 0) {
      return res.status(400).render('admin/geplante-jobs', {
        cronSyncPersonenStunde: syncPersonenStunde,
        cronSyncPersonenMinute: syncPersonenMinute,
        cronPoolErinnerungenIntervallMinuten: poolErinnerungenIntervallMinuten,
        cronPdfBereinigungStunde: pdfBereinigungStunde,
        cronPdfBereinigungMinute: pdfBereinigungMinute,
        cronZeitstempelNachholenIntervallMinuten: zeitstempelNachholenIntervallMinuten,
        syncLog: listRecentSyncLogs(db, LOG_LIMIT),
        poolErinnerungenLog: listRecentCronLog(db, 'pool-erinnerungen', LOG_LIMIT),
        pdfBereinigungLog: listRecentCronLog(db, 'pdf-bereinigung', LOG_LIMIT),
        zeitstempelNachholenLog: listRecentCronLog(db, 'zeitstempel-nachholen', LOG_LIMIT),
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
    setConfigValue(db, 'cron_zeitstempel_nachholen_intervall_minuten', String(zeitstempelIntervallNum));
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

  return router;
}
