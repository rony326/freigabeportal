// Maschinenroute `/internal/cron/*` (Header `X-Cron-Secret`, docs/n8n-schnittstelle.md bzw. docs/geplante-jobs-und-benachrichtigungen.md): löst die Hintergrund-Jobs von
// aussen aus. Antwort 200 bei Erfolg, 409 bei "übersprungen" (z. B. läuft schon), 500 bei Fehler (siehe httpStatusFuer).

import { Router } from 'express';
import { machineAuditContext } from '../services/auditContext.js';
import { runTsaCrlAktualisierungJob } from '../services/tsaCrlUpdate.js';
import { runSyncPersonenJob, runPoolErinnerungenJob, runPdfBereinigungJob, runZeitstempelNachholenJob, runSplitGruppenNachholenJob, runFreigabe2ErinnerungenJob, runRapportErinnerungenJob, runKkBelegErinnerungenJob, runMailZustellungJob } from '../services/cronJobs.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

// Bildet den Job-Status auf einen HTTP-Status ab.
function httpStatusFuer(status) {
  if (status === 'uebersprungen') return 409;
  if (status === 'fehler') return 500;
  return 200;
}

// requireCronSecret wird einmal bei der Einbindung in app.js angewendet, nicht je Route hier — entsprechend dem Sammelschutz, den /admin schon nutzt, damit
// eine später in diesen Router eingefügte Route automatisch abgesichert ist, statt einen eigenen ausdrücklichen Schutz zu brauchen.
//
// Der In-Process-Scheduler (services/scheduler.js) führt dieselben Jobs inzwischen mit eigenen Timern aus — diese Endpunkte bleiben für das bedarfsweise/manuelle
// Auslösen (siehe die Go-Live-Checkliste im README) und als Rückfall für alle bestehen, die einen funktionierenden externen Scheduler haben.
export function createCronRouter({ db, config, mailer }) {
  const router = Router();
  router.use(machineAuditContext('service:cron', 'Cron API'));

  // POST /internal/cron/sync-personen – Personen-Sync mit ChurchTools. (Die anderen Routen unten lösen den gleichnamigen Job aus.)
  router.post('/sync-personen', asyncHandler(async (req, res, next) => {
    try {
      const result = await runSyncPersonenJob(db, config, mailer);
      res.status(httpStatusFuer(result.status)).json(result);
    } catch (err) {
      next(err);
    }
  }));

  router.post('/pool-erinnerungen', asyncHandler(async (req, res, next) => {
    try {
      const result = await runPoolErinnerungenJob(db, config, mailer);
      res.status(httpStatusFuer(result.status)).json(result);
    } catch (err) {
      next(err);
    }
  }));

  router.post('/freigabe2-erinnerungen', asyncHandler(async (req, res, next) => {
    try {
      const result = await runFreigabe2ErinnerungenJob(db, config, mailer);
      res.status(httpStatusFuer(result.status)).json(result);
    } catch (err) {
      next(err);
    }
  }));

  router.post('/rapport-erinnerungen', asyncHandler(async (req, res, next) => {
    try {
      const result = await runRapportErinnerungenJob(db, config, mailer);
      res.status(httpStatusFuer(result.status)).json(result);
    } catch (err) {
      next(err);
    }
  }));

  router.post('/pdf-bereinigung', asyncHandler(async (req, res, next) => {
    try {
      const result = await runPdfBereinigungJob(db, config);
      res.status(httpStatusFuer(result.status)).json(result);
    } catch (err) {
      next(err);
    }
  }));

  router.post('/tsa-crl-aktualisierung', asyncHandler(async (req, res, next) => {
    try {
      const result = await runTsaCrlAktualisierungJob(db, config, mailer);
      res.status(httpStatusFuer(result.status)).json(result);
    } catch (err) {
      next(err);
    }
  }));

  router.post('/zeitstempel-nachholen', asyncHandler(async (req, res, next) => {
    try {
      const result = await runZeitstempelNachholenJob(db, config);
      res.status(httpStatusFuer(result.status)).json(result);
    } catch (err) {
      next(err);
    }
  }));

  router.post('/split-gruppen-nachholen', asyncHandler(async (req, res, next) => {
    try {
      const result = await runSplitGruppenNachholenJob(db, config);
      res.status(httpStatusFuer(result.status)).json(result);
    } catch (err) {
      next(err);
    }
  }));

  router.post('/kk-beleg-erinnerungen', asyncHandler(async (req, res, next) => {
    try {
      const result = await runKkBelegErinnerungenJob(db, config, mailer);
      res.status(httpStatusFuer(result.status)).json(result);
    } catch (err) {
      next(err);
    }
  }));

  router.post('/mail-zustellung', asyncHandler(async (req, res, next) => {
    try {
      const result = await runMailZustellungJob(db, config, mailer);
      // "Nichts fällig" ist kein Konflikt: 200 statt 409.
      res.status(result.status === 'uebersprungen' ? 200 : httpStatusFuer(result.status)).json(result);
    } catch (err) {
      next(err);
    }
  }));

  return router;
}
