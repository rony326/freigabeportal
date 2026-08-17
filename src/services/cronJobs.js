import { existsSync, unlinkSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { runPersonenSync } from './sync.js';
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
import { sendNotification, resolveEmpfaenger } from './notify.js';
import { logCronLauf } from '../db/cronLogRepo.js';

const TMP_MAX_ALTER_MS = 60 * 60 * 1000; // 1 Stunde

// The actual job bodies behind /internal/cron/* (routes/cron.js, manual/on-demand triggering)
// and the in-process scheduler (services/scheduler.js, the normal way these now run) — extracted
// here so both trigger paths call the exact same logic instead of risking drift between two
// copies. Each function returns a plain result object rather than touching an HTTP response;
// the route layer maps `status` to an HTTP status code.

async function benachrichtigeSyncFehler(db, config, mailer, meldung) {
  const empfaenger = resolveEmpfaenger(db, config, getConfigValue(db, 'sync_fehler_empfaenger'));
  for (const email of empfaenger) {
    await sendNotification(db, mailer, {
      to: email,
      subject: 'Freigabeportal: ChurchTools-Sync fehlgeschlagen',
      text: `Der ChurchTools-Personen-Sync konnte nicht erfolgreich abgeschlossen werden: ${meldung}\n\nBitte im Freigabeportal anmelden: ${config.publicBaseUrl}/admin/sync`,
      typ: 'sync-fehler',
      jobId: null,
    });
  }
}

export async function runSyncPersonenJob(db, config, mailer) {
  if (hasRecentRunningSync(db)) {
    return { status: 'uebersprungen', meldung: 'Ein Sync-Lauf ist bereits aktiv' };
  }
  try {
    const result = await runPersonenSync(db, config.churchtools, config.churchtools.syncServiceToken);
    if (result.abgebrochen) {
      await benachrichtigeSyncFehler(db, config, mailer, result.meldung);
      return { status: 'abgebrochen', meldung: result.meldung };
    }
    return { status: 'erfolg', ...result };
  } catch (err) {
    await benachrichtigeSyncFehler(db, config, mailer, err.message);
    return { status: 'fehler', error: err.message };
  }
}

export async function runPoolErinnerungenJob(db, config, mailer) {
  const gestartetAm = new Date().toISOString();
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

    const ergebnis = { status: 'erfolg', reminder: reminderJobs.length, eskalation: eskalationJobs.length };
    logCronLauf(db, {
      job: 'pool-erinnerungen',
      gestartetAm,
      beendetAm: new Date().toISOString(),
      status: 'erfolg',
      details: `Reminder: ${ergebnis.reminder}, Eskalation: ${ergebnis.eskalation}`,
    });
    return ergebnis;
  } catch (err) {
    logCronLauf(db, { job: 'pool-erinnerungen', gestartetAm, beendetAm: new Date().toISOString(), status: 'fehler', details: err.message });
    return { status: 'fehler', error: err.message };
  }
}

export function runPdfBereinigungJob(db, config) {
  const gestartetAm = new Date().toISOString();
  let archiviert = 0;
  try {
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
  } catch (err) {
    console.error('Archivierungs-Sweep fehlgeschlagen:', err.message);
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

  let mailLogGeloescht = 0;
  try {
    const aufbewahrungTage = Number(getConfigValue(db, 'mail_log_aufbewahrung_tage'));
    const mailLogSchwelle = new Date(Date.now() - aufbewahrungTage * 24 * 60 * 60 * 1000).toISOString();
    mailLogGeloescht = pruneMailLogOlderThan(db, mailLogSchwelle);
  } catch (err) {
    console.error('Bereinigung von mail_log fehlgeschlagen:', err.message);
  }

  const ergebnis = { status: 'erfolg', archiviert, tmpGeloescht, mailLogGeloescht };
  logCronLauf(db, {
    job: 'pdf-bereinigung',
    gestartetAm,
    beendetAm: new Date().toISOString(),
    status: 'erfolg',
    details: `Archiviert: ${archiviert}, Tmp gelöscht: ${tmpGeloescht}, Mail-Log bereinigt: ${mailLogGeloescht}`,
  });
  return ergebnis;
}
