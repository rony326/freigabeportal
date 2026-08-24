import { Router } from 'express';
import { runSyncPersonenJob, runPoolErinnerungenJob, runPdfBereinigungJob, runZeitstempelNachholenJob } from '../services/cronJobs.js';

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

  router.post('/pdf-bereinigung', async (req, res, next) => {
    try {
      const result = await runPdfBereinigungJob(db, config);
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

  return router;
}
