import { Router } from 'express';
import { runPersonenSync } from '../services/sync.js';
import { hasRecentRunningSync } from '../db/syncLogRepo.js';
import { getConfigValue } from '../db/adminConfigRepo.js';
import { listPoolJobsForReminder, markReminderGesendet, listPoolJobsForEskalation, markEskalationGesendet } from '../db/jobsRepo.js';
import { sendNotification, resolveEmpfaenger } from '../services/notify.js';

// requireCronSecret is applied once at the app.js mount, not per-route here — matching the
// blanket-guard pattern /admin already uses, so a future route added to this router is
// gated automatically rather than needing its own explicit guard.
export function createCronRouter({ db, config, mailer }) {
  const router = Router();

  router.post('/sync-personen', async (req, res) => {
    if (hasRecentRunningSync(db)) {
      return res.status(409).json({ error: 'Ein Sync-Lauf ist bereits aktiv' });
    }
    try {
      const result = await runPersonenSync(db, config.churchtools, config.churchtools.syncServiceToken);
      res.json({ status: 'erfolg', ...result });
    } catch (err) {
      res.status(500).json({ status: 'fehler', error: err.message });
    }
  });

  router.post('/pool-erinnerungen', async (req, res) => {
    try {
      const reminderStunden = Number(getConfigValue(db, 'reminder_stunden'));
      const eskalationStunden = Number(getConfigValue(db, 'eskalation_stunden'));

      const reminderJobs = listPoolJobsForReminder(db, reminderStunden);
      for (const job of reminderJobs) {
        const empfaenger = resolveEmpfaenger(db, config, getConfigValue(db, 'reminder_empfaenger'));
        for (const email of empfaenger) {
          await sendNotification(db, mailer, {
            to: email,
            subject: 'Freigabeportal: Rechnung wartet im Pool',
            text: `Diese Rechnung ist seit mehr als ${reminderStunden} Stunden unbeansprucht im Pool: ${job.dateiname}\n\nBitte im Freigabeportal anmelden: ${config.publicBaseUrl}/pool`,
            typ: 'reminder',
            jobId: job.id,
          });
        }
        if (empfaenger.length > 0) {
          markReminderGesendet(db, job.id);
        }
      }

      const eskalationJobs = listPoolJobsForEskalation(db, eskalationStunden);
      for (const job of eskalationJobs) {
        const empfaenger = resolveEmpfaenger(db, config, getConfigValue(db, 'eskalation_empfaenger'));
        for (const email of empfaenger) {
          await sendNotification(db, mailer, {
            to: email,
            subject: 'Freigabeportal: Eskalation – Rechnung seit langem unbeansprucht',
            text: `Diese Rechnung ist seit mehr als ${eskalationStunden} Stunden unbeansprucht im Pool und wurde eskaliert: ${job.dateiname}\n\nBitte im Freigabeportal anmelden: ${config.publicBaseUrl}/pool`,
            typ: 'eskalation',
            jobId: job.id,
          });
        }
        if (empfaenger.length > 0) {
          markEskalationGesendet(db, job.id);
        }
      }

      res.json({ status: 'erfolg', reminder: reminderJobs.length, eskalation: eskalationJobs.length });
    } catch (err) {
      res.status(500).json({ status: 'fehler', error: err.message });
    }
  });

  return router;
}
