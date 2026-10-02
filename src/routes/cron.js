import { Router } from 'express';
import { machineAuditContext } from '../services/auditContext.js';
import { runTsaCrlAktualisierungJob } from '../services/tsaCrlUpdate.js';
import { runSyncPersonenJob, runPoolErinnerungenJob, runPdfBereinigungJob, runZeitstempelNachholenJob, runSplitGruppenNachholenJob, runFreigabe2ErinnerungenJob, runKkBelegErinnerungenJob, runMailZustellungJob } from '../services/cronJobs.js';

function httpStatusFuer(status) {
  if (status === 'uebersprungen') return 409;
  if (status === 'fehler') return 500;
  return 200;
}

// requireCronSecret is applied once at the app.js mount, not per-route here — matching the
// blanket-guard pattern /admin already uses, so a future route added to this router is
// gated automatically rather than needing its own explicit guard.
//
// The in-process scheduler (services/scheduler.js) now runs these same jobs on its own timers —
// these endpoints stay in place for on-demand/manual triggering (see README's go-live checklist)
// and as a fallback for anyone who does have a working external scheduler.
export function createCronRouter({ db, config, mailer }) {
  const router = Router();
  router.use(machineAuditContext('service:cron', 'Cron API'));

  router.post('/sync-personen', async (req, res, next) => {
    try {
      const result = await runSyncPersonenJob(db, config, mailer);
      res.status(httpStatusFuer(result.status)).json(result);
    } catch (err) {
      next(err);
    }
  });

  router.post('/pool-erinnerungen', async (req, res, next) => {
    try {
      const result = await runPoolErinnerungenJob(db, config, mailer);
      res.status(httpStatusFuer(result.status)).json(result);
    } catch (err) {
      next(err);
    }
  });

  router.post('/freigabe2-erinnerungen', async (req, res, next) => {
    try {
      const result = await runFreigabe2ErinnerungenJob(db, config, mailer);
      res.status(httpStatusFuer(result.status)).json(result);
    } catch (err) {
      next(err);
    }
  });

  router.post('/pdf-bereinigung', async (req, res, next) => {
    try {
      const result = await runPdfBereinigungJob(db, config);
      res.status(httpStatusFuer(result.status)).json(result);
    } catch (err) {
      next(err);
    }
  });

  router.post('/tsa-crl-aktualisierung', async (req, res, next) => {
    try {
      const result = await runTsaCrlAktualisierungJob(db, config, mailer);
      res.status(httpStatusFuer(result.status)).json(result);
    } catch (err) {
      next(err);
    }
  });

  router.post('/zeitstempel-nachholen', async (req, res, next) => {
    try {
      const result = await runZeitstempelNachholenJob(db, config);
      res.status(httpStatusFuer(result.status)).json(result);
    } catch (err) {
      next(err);
    }
  });

  router.post('/split-gruppen-nachholen', async (req, res, next) => {
    try {
      const result = await runSplitGruppenNachholenJob(db, config);
      res.status(httpStatusFuer(result.status)).json(result);
    } catch (err) {
      next(err);
    }
  });

  router.post('/kk-beleg-erinnerungen', async (req, res, next) => {
    try {
      const result = await runKkBelegErinnerungenJob(db, config, mailer);
      res.status(httpStatusFuer(result.status)).json(result);
    } catch (err) {
      next(err);
    }
  });

  router.post('/mail-zustellung', async (req, res, next) => {
    try {
      const result = await runMailZustellungJob(db, config, mailer);
      // "Nichts fällig" ist kein Konflikt: 200 statt 409.
      res.status(result.status === 'uebersprungen' ? 200 : httpStatusFuer(result.status)).json(result);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
