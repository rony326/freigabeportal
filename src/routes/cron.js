import { Router } from 'express';
import { existsSync, unlinkSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { runPersonenSync } from '../services/sync.js';
import { hasRecentRunningSync } from '../db/syncLogRepo.js';
import { getConfigValue } from '../db/adminConfigRepo.js';
import {
  listPoolJobsForReminder,
  markReminderGesendet,
  listPoolJobsForEskalation,
  markEskalationGesendet,
  listAbgeholtJobs,
  archivierenJob,
} from '../db/jobsRepo.js';
import { pruneMailLogOlderThan } from '../db/mailLogRepo.js';
import { sendNotification, resolveEmpfaenger } from '../services/notify.js';

const TMP_MAX_ALTER_MS = 60 * 60 * 1000; // 1 Stunde

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

  router.post('/pdf-bereinigung', (req, res) => {
    let archiviert = 0;
    for (const job of listAbgeholtJobs(db)) {
      let pdfWeg = true;
      if (job.pdf_pfad) {
        try {
          if (existsSync(job.pdf_pfad)) unlinkSync(job.pdf_pfad);
        } catch (err) {
          console.error(`Löschen der PDF für archivierten Job ${job.id} fehlgeschlagen:`, err.message);
          pdfWeg = !existsSync(job.pdf_pfad);
        }
      }
      let thumbnailWeg = true;
      if (job.thumbnail_pfad) {
        try {
          if (existsSync(job.thumbnail_pfad)) unlinkSync(job.thumbnail_pfad);
        } catch (err) {
          console.error(`Löschen des Thumbnails für archivierten Job ${job.id} fehlgeschlagen:`, err.message);
          thumbnailWeg = !existsSync(job.thumbnail_pfad);
        }
      }
      if (pdfWeg && thumbnailWeg) {
        if (archivierenJob(db, job.id)) archiviert += 1;
      }
    }

    let tmpGeloescht = 0;
    try {
      const schwelle = Date.now() - TMP_MAX_ALTER_MS;
      for (const name of readdirSync(config.jobsDir)) {
        if (!name.endsWith('.tmp')) continue;
        const pfad = join(config.jobsDir, name);
        try {
          if (statSync(pfad).mtimeMs < schwelle) {
            unlinkSync(pfad);
            tmpGeloescht += 1;
          }
        } catch (err) {
          console.error(`Löschen der verwaisten Tmp-Datei ${pfad} fehlgeschlagen:`, err.message);
        }
      }
    } catch (err) {
      console.error('Tmp-Sweep konnte jobsDir nicht lesen:', err.message);
    }

    const aufbewahrungTage = Number(getConfigValue(db, 'mail_log_aufbewahrung_tage'));
    const mailLogSchwelle = new Date(Date.now() - aufbewahrungTage * 24 * 60 * 60 * 1000).toISOString();
    const mailLogGeloescht = pruneMailLogOlderThan(db, mailLogSchwelle);

    res.json({ status: 'erfolg', archiviert, tmpGeloescht, mailLogGeloescht });
  });

  return router;
}
