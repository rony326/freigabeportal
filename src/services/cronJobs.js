import { existsSync, unlinkSync, readdirSync, statSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { buildBackupArchive, backupDateiname, BACKUP_DATEINAME_PATTERN } from './backup.js';
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
  markZeitstempelGesetzt,
  listZeitstempelAusstehendJobs,
  listSplitGruppenAusstehend,
} from '../db/jobsRepo.js';
import { pruneMailLogOlderThan } from '../db/mailLogRepo.js';
import { sendNotification, resolveEmpfaenger } from './notify.js';
import { logCronLauf, startCronLauf, finishCronLauf, hasRecentRunningCronLauf } from '../db/cronLogRepo.js';
import { setZeitstempel } from './zeitstempel.js';
import { pruefeUndFinalisiereSplitGruppe } from './splitGruppenExport.js';

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

// Best-effort retry for jobs whose Freigabe-2 completion (freigabe2.js) either had no TSA
// configured at the time, or attempted setZeitstempel and failed (TSA outage). Silently does
// nothing (no log entry) when the feature is unconfigured, matching setZeitstempel's own
// "empty zeitstempel_tsa_url = feature disabled" behavior at Freigabe-2 completion. Each pending
// job is tried independently — one job's TSA failure or missing PDF file must never stop the
// others in the same run from being retried.
//
// Overlap guard: unlike pool-erinnerungen/pdf-bereinigung (fast, no per-item network round-trip),
// each iteration here awaits a real TSA call, so a batch can take a while — Task 5's manual
// "Jetzt ausführen" trigger calls this exact function too, and could otherwise fire while a
// scheduled run is still mid-batch. Same start/finish/hasRecentRunning pattern as
// runSyncPersonenJob's hasRecentRunningSync guard, just scoped to cron_log via
// startCronLauf/finishCronLauf/hasRecentRunningCronLauf instead of sync_log.
export async function runZeitstempelNachholenJob(db, config) {
  const tsaUrl = getConfigValue(db, 'zeitstempel_tsa_url');
  if (!tsaUrl) {
    return { status: 'uebersprungen', nachgeholt: 0 };
  }
  if (hasRecentRunningCronLauf(db, 'zeitstempel-nachholen')) {
    return { status: 'uebersprungen', nachgeholt: 0, meldung: 'Ein Zeitstempel-Nachholen-Lauf ist bereits aktiv' };
  }

  const laufId = startCronLauf(db, 'zeitstempel-nachholen');
  try {
    const tsaConfig = {
      url: tsaUrl,
      user: getConfigValue(db, 'zeitstempel_tsa_user') || undefined,
      passwort: getConfigValue(db, 'zeitstempel_tsa_passwort') || undefined,
    };

    const ausstehend = listZeitstempelAusstehendJobs(db);
    let nachgeholt = 0;
    let fehlgeschlagen = 0;
    let dateiFehlt = 0;
    for (const job of ausstehend) {
      // Bekannte Einschränkung (siehe Spec): sobald n8n den Job abgeholt hat, löscht das Portal
      // die lokale PDF-Datei -- ein Zeitstempel kann für diesen Job dann nicht mehr nachgeholt
      // werden. Kein Fehler, nur ein Zählwert für die Sichtbarkeit im Log.
      if (!job.pdf_pfad || !existsSync(job.pdf_pfad)) {
        dateiFehlt += 1;
        continue;
      }
      try {
        const pdfBuffer = readFileSync(job.pdf_pfad);
        const stamped = await setZeitstempel(pdfBuffer, tsaConfig);
        const tmpPfad = `${job.pdf_pfad}.${randomUUID()}.tmp`;
        writeFileSync(tmpPfad, stamped);
        renameSync(tmpPfad, job.pdf_pfad);
        markZeitstempelGesetzt(db, job.id, new Date().toISOString(), createHash('sha256').update(stamped).digest('hex'));
        nachgeholt += 1;
      } catch (err) {
        fehlgeschlagen += 1;
        console.error(`Zeitstempel-Nachholen für Job ${job.id} fehlgeschlagen:`, err.message);
      }
    }

    const ergebnis = { status: 'erfolg', nachgeholt, fehlgeschlagen, dateiFehlt };
    finishCronLauf(db, laufId, {
      beendetAm: new Date().toISOString(),
      status: 'erfolg',
      details: `Nachgeholt: ${nachgeholt}, Fehlgeschlagen: ${fehlgeschlagen}, Datei fehlt: ${dateiFehlt}`,
    });
    return ergebnis;
  } catch (err) {
    finishCronLauf(db, laufId, { beendetAm: new Date().toISOString(), status: 'fehler', details: err.message });
    return { status: 'fehler', error: err.message };
  }
}

// Läuft wie zeitstempel-nachholen mit Zwei-Phasen-Logging (Overlap-Guard) statt des
// Einzelschuss-logCronLauf der schnellen Jobs -- das Zippen von JOBS_DIR/BRANDING_DIR kann bei
// vielen Dateien länger dauern als pool-erinnerungen/pdf-bereinigung.
export function runDatenbankSicherungJob(db, config) {
  if (hasRecentRunningCronLauf(db, 'datenbank-sicherung')) {
    return { status: 'uebersprungen', meldung: 'Ein Backup-Lauf ist bereits aktiv' };
  }

  const laufId = startCronLauf(db, 'datenbank-sicherung');
  try {
    mkdirSync(config.backupDir, { recursive: true });
    const archiv = buildBackupArchive(db, config);
    const dateiname = backupDateiname(new Date());
    writeFileSync(join(config.backupDir, dateiname), archiv);

    // Retention-Bereinigung ist absichtlich in einem eigenen try/catch isoliert (analog zu den
    // drei unabhängigen Schritten in runPdfBereinigungJob): das neue Backup ist zu diesem
    // Zeitpunkt bereits erfolgreich auf der Platte -- ein unlinkSync-Fehler beim Aufräumen alter
    // Dateien (z.B. Berechtigungsproblem) darf den gesamten Lauf nicht als 'fehler' melden, denn
    // sowohl der Scheduler (Task 6) als auch das Admin-UI (Task 7) werten `status` direkt aus.
    let bereinigt = 0;
    try {
      const aufbewahrungAnzahl = Number(getConfigValue(db, 'backup_aufbewahrung_anzahl')) || 14;
      const vorhandene = readdirSync(config.backupDir)
        .filter((name) => BACKUP_DATEINAME_PATTERN.test(name))
        .sort();
      const zuLoeschendeAnzahl = vorhandene.length - aufbewahrungAnzahl;
      for (let i = 0; i < zuLoeschendeAnzahl; i += 1) {
        unlinkSync(join(config.backupDir, vorhandene[i]));
        bereinigt += 1;
      }
    } catch (err) {
      console.error('Bereinigung alter Backups fehlgeschlagen:', err.message);
    }

    const ergebnis = { status: 'erfolg', dateiname, groesseBytes: archiv.length, bereinigt };
    finishCronLauf(db, laufId, {
      beendetAm: new Date().toISOString(),
      status: 'erfolg',
      details: `Datei: ${dateiname}, Grösse: ${archiv.length} Bytes, Bereinigt: ${bereinigt}`,
    });
    return ergebnis;
  } catch (err) {
    finishCronLauf(db, laufId, { beendetAm: new Date().toISOString(), status: 'fehler', details: err.message });
    return { status: 'fehler', error: err.message };
  }
}

// Nachholt Splitgruppen, deren Merge beim ersten Versuch (Freigabe-2-Abschluss des letzten
// Kindes, oder Löschung einer blockierenden abgelehnten Zeile) fehlgeschlagen ist -- TSA-Ausfall,
// beschädigtes Kind-PDF -- oder die zum Zeitpunkt des letzten Auslösers noch unvollständig war.
// Jede Gruppe wird unabhängig versucht: ein fehlerhaftes Kind-PDF in einer Gruppe darf die
// anderen Gruppen im selben Lauf nicht blockieren.
export async function runSplitGruppenNachholenJob(db, config) {
  if (hasRecentRunningCronLauf(db, 'split-gruppen-nachholen')) {
    return { status: 'uebersprungen', nachgeholt: 0, meldung: 'Ein Splitgruppen-Nachholen-Lauf ist bereits aktiv' };
  }

  const laufId = startCronLauf(db, 'split-gruppen-nachholen');
  try {
    const ausstehend = listSplitGruppenAusstehend(db);
    let nachgeholt = 0;
    let fehlgeschlagen = 0;
    let uebersprungen = 0;
    for (const parent of ausstehend) {
      const ergebnis = await pruefeUndFinalisiereSplitGruppe(db, config, parent.id);
      if (ergebnis.status === 'exportiert') nachgeholt += 1;
      else if (ergebnis.status === 'fehler') fehlgeschlagen += 1;
      else uebersprungen += 1;
    }

    finishCronLauf(db, laufId, {
      beendetAm: new Date().toISOString(),
      status: 'erfolg',
      details: `Nachgeholt: ${nachgeholt}, Fehlgeschlagen: ${fehlgeschlagen}, Übersprungen: ${uebersprungen}`,
    });
    return { status: 'erfolg', nachgeholt, fehlgeschlagen, uebersprungen };
  } catch (err) {
    finishCronLauf(db, laufId, { beendetAm: new Date().toISOString(), status: 'fehler', details: err.message });
    return { status: 'fehler', error: err.message };
  }
}
