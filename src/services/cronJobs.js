import { existsSync, unlinkSync, readdirSync, statSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { writeFinalDocument } from './finalDocument.js';
import { tsaTrustOptions } from './tsaTrust.js';
import { hasMatureArchiveReceipt, archivedBytesMatch } from './archiveReceipt.js';
import { backupDateiname, ENCRYPTED_BACKUP_DATEINAME_PATTERN } from './backup.js';
import { buildEncryptedBackup, publishEncryptedBackup } from './backupEnvelope.js';
import { deleteBackupWithAudit } from './backupAudit.js';
import { loescheDateiMitAudit } from './dateiAudit.js';
import { pruefeVerwaisteFinaleDateien } from './verwaisteDateien.js';
import { auditedJob } from './auditOperation.js';
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
  listFreigabe2JobsForReminder,
  markFreigabe2ReminderGesendet,
  listFreigabe2JobsForEskalation,
  markFreigabe2EskalationGesendet,
  forceEskalierenFreigabe2AnAdmin,
  getEffectiveFreigeber2Id,
  listKkAbrechnungenFuerErinnerung,
  markKkAbrechnungErinnert,
} from '../db/jobsRepo.js';
import {
  listKkBelegeFuerErinnerung,
  markKkBelegErinnert,
  listVerworfeneKkBelegeZurLoeschung,
  markKkBelegDateiGeloescht,
  logKkBelegEreignis,
} from '../db/kkBelegeRepo.js';
import { getKontoById } from '../db/kontenRepo.js';
import { getPersonById } from '../db/personenRepo.js';
import { pruneMailLogOlderThan, listGeplantMailsGruppiertNachEmpfaenger } from '../db/mailLogRepo.js';
import { sendNotification, resolveEmpfaenger, reiheBenachrichtigungEin, reiheBenachrichtigungMitVertretungEin } from './notify.js';
import {
  bilanzHatFehler,
  bilanzText,
  stelleEintraegeZu,
  ladeDigestVorlage,
  markiereDigestZeilenFehlgeschlagen,
  stelleDigestZu,
  stelleFaelligeMailsZu,
  hatFaelligeMails,
} from './mailZustellung.js';
import { logCronLauf, startCronLauf, finishCronLauf, hasRecentRunningCronLauf } from '../db/cronLogRepo.js';
import { setZeitstempelMitNachweis } from './zeitstempel.js';
import { speichereTsaNachweis } from './tsaNachweis.js';
import { pruefeUndFinalisiereSplitGruppe } from './splitGruppenExport.js';

const TMP_MAX_ALTER_MS = 60 * 60 * 1000; // 1 Stunde

// Tage-Einstellung aus admin_config: nur eine ganze Zahl >= 1 zählt, sonst der Default -- ein
// negativer Wert würde die Schwelle in die Zukunft legen (z.B. frisch verworfene Belege löschen).
function tageAusConfig(db, key, standard) {
  const wert = Number(getConfigValue(db, key));
  return Number.isInteger(wert) && wert >= 1 ? wert : standard;
}

// Planungsphase der Erinnerungsjobs: fällige Einträge auswählen, Mails dauerhaft einreihen und
// den fachlichen Marker setzen -- synchron in EINER Transaktion. Parallele Auslöser (Scheduler und
// manueller /internal/cron-Aufruf) können sich dadurch nicht überholen, und ein Marker steht nie
// ohne eingereihte Mail (oder umgekehrt). Die eigentliche Zustellung folgt danach
// (stelleEintraegeZu); SMTP-Fehler bleiben 'eingereiht' und werden von mail-zustellung wiederholt.
function planeInTransaktion(db, plan) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = plan();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw err;
  }
}

// Cron-Ergebnis mit Zustellbilanz: ein Lauf mit Zustellfehlern ist kein 'erfolg', auch wenn die
// Erinnerungen fachlich eingereiht sind -- sonst bleibt ein SMTP-Ausfall im Verlauf unsichtbar.
function abschlussMitBilanz(fachlich, bilanz) {
  const fehler = bilanzHatFehler(bilanz);
  return {
    status: fehler ? 'fehler' : 'erfolg',
    details: `${fachlich}; ${bilanzText(bilanz)}`,
    ...(fehler ? { error: `Zustellung teilweise fehlgeschlagen: ${bilanzText(bilanz)}` } : {}),
  };
}

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
      typ: 'sync-fehler',
      jobId: null,
      variablen: {
        fehlerDetails: meldung,
        zeitpunkt: new Date().toISOString(),
        link: `${config.publicBaseUrl}/admin/sync`,
      },
    });
  }
}

export const runSyncPersonenJob = auditedJob('sync-personen', runSyncPersonenJobInternal);

async function runSyncPersonenJobInternal(db, config, mailer) {
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

export const runPoolErinnerungenJob = auditedJob('pool-erinnerungen', runPoolErinnerungenJobInternal);

async function runPoolErinnerungenJobInternal(db, config, mailer) {
  const gestartetAm = new Date().toISOString();
  try {
    const reminderStunden = Number(getConfigValue(db, 'reminder_stunden'));
    const eskalationStunden = Number(getConfigValue(db, 'eskalation_stunden'));

    const plan = planeInTransaktion(db, () => {
      const eintraege = [];
      let reminder = 0;
      let eskalation = 0;
      const reminderEmpfaenger = resolveEmpfaenger(db, config, getConfigValue(db, 'reminder_empfaenger'));
      for (const job of listPoolJobsForReminder(db, reminderStunden)) {
        // Ohne Empfänger wird nichts markiert (nächster Lauf versucht es erneut), der Job zählt
        // aber als fällig. Ein bereits gesetzter Marker heisst: ein paralleler Lauf war schneller.
        if (reminderEmpfaenger.length === 0) { reminder += 1; continue; }
        if (!markReminderGesendet(db, job.id)) continue;
        for (const email of reminderEmpfaenger) {
          eintraege.push(reiheBenachrichtigungEin(db, {
            to: email,
            typ: 'reminder',
            jobId: job.id,
            variablen: { jobDateiname: job.dateiname, stunden: reminderStunden, link: `${config.publicBaseUrl}/pool` },
          }));
        }
        reminder += 1;
      }
      const eskalationEmpfaenger = resolveEmpfaenger(db, config, getConfigValue(db, 'eskalation_empfaenger'));
      for (const job of listPoolJobsForEskalation(db, eskalationStunden)) {
        if (eskalationEmpfaenger.length === 0) { eskalation += 1; continue; }
        if (!markEskalationGesendet(db, job.id)) continue;
        for (const email of eskalationEmpfaenger) {
          eintraege.push(reiheBenachrichtigungEin(db, {
            to: email,
            typ: 'eskalation',
            jobId: job.id,
            variablen: { jobDateiname: job.dateiname, stunden: eskalationStunden, link: `${config.publicBaseUrl}/pool` },
          }));
        }
        eskalation += 1;
      }
      return { eintraege, reminder, eskalation };
    });

    const bilanz = await stelleEintraegeZu(db, mailer, plan.eintraege);
    const abschluss = abschlussMitBilanz(`Reminder: ${plan.reminder}, Eskalation: ${plan.eskalation}`, bilanz);
    logCronLauf(db, { job: 'pool-erinnerungen', gestartetAm, beendetAm: new Date().toISOString(), status: abschluss.status, details: abschluss.details });
    return { status: abschluss.status, reminder: plan.reminder, eskalation: plan.eskalation, mails: bilanz, ...(abschluss.error ? { error: abschluss.error } : {}) };
  } catch (err) {
    logCronLauf(db, { job: 'pool-erinnerungen', gestartetAm, beendetAm: new Date().toISOString(), status: 'fehler', details: err.message });
    return { status: 'fehler', error: err.message };
  }
}

export const runFreigabe2ErinnerungenJob = auditedJob('freigabe2-erinnerungen', runFreigabe2ErinnerungenJobInternal);

async function runFreigabe2ErinnerungenJobInternal(db, config, mailer) {
  const gestartetAm = new Date().toISOString();
  try {
    const reminderStunden = Number(getConfigValue(db, 'freigabe2_reminder_stunden'));
    const eskalationStunden = Number(getConfigValue(db, 'freigabe2_eskalation_stunden'));

    const plan = planeInTransaktion(db, () => {
      const eintraege = [];
      let reminder = 0;
      for (const job of listFreigabe2JobsForReminder(db, reminderStunden)) {
        const konto = getKontoById(db, job.konto_id);
        if (!konto) continue; // deleted/unresolvable Konto -- listStalledJobs covers this separately
        const akteurId = getEffectiveFreigeber2Id(job, konto);
        const akteur = getPersonById(db, akteurId);
        if (!akteur || !akteur.aktiv || akteur.ct_person_unresolved) continue; // ditto -- inactive/unresolved actor
        if (!markFreigabe2ReminderGesendet(db, job.id)) continue;
        eintraege.push(reiheBenachrichtigungEin(db, {
          to: akteur.email,
          typ: 'freigabe2-reminder',
          jobId: job.id,
          variablen: {
            empfaengerName: `${akteur.vorname} ${akteur.nachname}`,
            jobDateiname: job.dateiname,
            stunden: reminderStunden,
            // Konkrete Freigabeseite; eine Übersicht /freigabe2 ohne ID gibt es nicht.
            link: `${config.publicBaseUrl}/freigabe2/${job.id}`,
          },
        }));
        reminder += 1;
      }

      let eskalation = 0;
      // Same recipients apply to every job in this phase of a given run.
      const empfaenger = resolveEmpfaenger(db, config, getConfigValue(db, 'freigabe2_eskalation_empfaenger'));
      for (const job of listFreigabe2JobsForEskalation(db, eskalationStunden)) {
        // Eskalation und Mail in derselben Transaktion: scheitert das Einreihen, bleibt auch die
        // Eskalation aus und der nächste Lauf versucht beides erneut.
        if (!forceEskalierenFreigabe2AnAdmin(db, job.id)) continue; // race: already handled
        for (const email of empfaenger) {
          eintraege.push(reiheBenachrichtigungEin(db, {
            to: email,
            typ: 'freigabe2-eskalation',
            jobId: job.id,
            variablen: { jobDateiname: job.dateiname, stunden: eskalationStunden, link: `${config.publicBaseUrl}/freigabe2/${job.id}` },
          }));
        }
        if (empfaenger.length > 0) markFreigabe2EskalationGesendet(db, job.id);
        eskalation += 1;
      }
      return { eintraege, reminder, eskalation };
    });

    const bilanz = await stelleEintraegeZu(db, mailer, plan.eintraege);
    const abschluss = abschlussMitBilanz(`Reminder: ${plan.reminder}, Eskalation: ${plan.eskalation}`, bilanz);
    logCronLauf(db, { job: 'freigabe2-erinnerungen', gestartetAm, beendetAm: new Date().toISOString(), status: abschluss.status, details: abschluss.details });
    return { status: abschluss.status, reminder: plan.reminder, eskalation: plan.eskalation, mails: bilanz, ...(abschluss.error ? { error: abschluss.error } : {}) };
  } catch (err) {
    logCronLauf(db, { job: 'freigabe2-erinnerungen', gestartetAm, beendetAm: new Date().toISOString(), status: 'fehler', details: err.message });
    return { status: 'fehler', error: err.message };
  }
}

export const runPdfBereinigungJob = auditedJob('pdf-bereinigung', runPdfBereinigungJobInternal);

// Loescht eine archivierte Datei mit Audit-Klammer. Scheitert bereits das Absichtsprotokoll, bleibt
// die Datei erhalten und der Job wird nicht als archiviert markiert (naechster Lauf versucht erneut).
function loescheArchivierteDatei(db, pfad, { objektId, dateiart }) {
  try {
    return loescheDateiMitAudit(db, pfad, { objekt: 'jobs', objektId, dateiart, anlass: 'PDF-Bereinigung nach bestaetigter Archivquittung' });
  } catch (err) {
    console.error(`Protokollierte Loeschung (${dateiart}) fuer Job ${objektId} nicht ausgefuehrt:`, err.code || 'AUDIT_FEHLER');
    return false;
  }
}

function runPdfBereinigungJobInternal(db, config) {
  const gestartetAm = new Date().toISOString();
  let archiviert = 0;
  try {
    for (const job of listAbgeholtJobs(db)) {
      if (!hasMatureArchiveReceipt(db, job) || !archivedBytesMatch(db, job)) continue;
      const pdfWeg = !job.pdf_pfad || loescheArchivierteDatei(db, job.pdf_pfad, { objektId: job.id, dateiart: 'beleg_pdf' });
      const thumbnailWeg = !job.thumbnail_pfad || loescheArchivierteDatei(db, job.thumbnail_pfad, { objektId: job.id, dateiart: 'thumbnail' });
      if (pdfWeg && thumbnailWeg) {
        if (archivierenJob(db, job.id)) archiviert += 1;
      }
    }
  } catch (err) {
    console.error('Archivierungs-Sweep fehlgeschlagen:', err.message);
  }

  // The group receipt protects the merged document as well as its child documents.
  for (const parent of db.prepare("SELECT * FROM jobs WHERE status = 'aufgesplittet' AND gruppe_abgeholt_am IS NOT NULL").all()) {
    if (!hasMatureArchiveReceipt(db, parent) || !archivedBytesMatch(db, parent)) continue;
    if (parent.gruppe_pdf_pfad && existsSync(parent.gruppe_pdf_pfad)) {
      loescheArchivierteDatei(db, parent.gruppe_pdf_pfad, { objektId: parent.id, dateiart: 'gruppen_pdf' });
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

  let mailLogGeloescht = 0;
  try {
    const aufbewahrungTage = Number(getConfigValue(db, 'mail_log_aufbewahrung_tage'));
    const mailLogSchwelle = new Date(Date.now() - aufbewahrungTage * 24 * 60 * 60 * 1000).toISOString();
    mailLogGeloescht = pruneMailLogOlderThan(db, mailLogSchwelle);
  } catch (err) {
    console.error('Bereinigung von mail_log fehlgeschlagen:', err.message);
  }

  // Verworfene Kreditkartenbelege: nach der Frist nur die Dateien löschen, die Zeile bleibt als
  // Nachweis (wer/wann/warum verworfen). Zugeordnete Belege sind Teil eines Buchungsdokuments und
  // werden hier nie angefasst.
  let kkBelegeGeloescht = 0;
  try {
    const tage = tageAusConfig(db, 'kk_beleg_verworfen_loeschen_tage', 90);
    const schwelle = new Date(Date.now() - tage * 24 * 60 * 60 * 1000).toISOString();
    for (const beleg of listVerworfeneKkBelegeZurLoeschung(db, schwelle)) {
      let alleWeg = true;
      for (const pfad of [beleg.pdf_pfad, beleg.thumbnail_pfad]) {
        if (!pfad) continue;
        try {
          if (existsSync(pfad)) unlinkSync(pfad);
        } catch (err) {
          console.error(`Löschen von ${pfad} (Kreditkartenbeleg ${beleg.id}) fehlgeschlagen:`, err.message);
          alleWeg = alleWeg && !existsSync(pfad);
        }
      }
      if (!alleWeg) continue;
      markKkBelegDateiGeloescht(db, beleg.id);
      logKkBelegEreignis(db, { belegId: beleg.id, personId: null, aktion: 'kk_beleg_datei_geloescht', kommentar: `Frist ${tage} Tage nach Verwerfen` });
      kkBelegeGeloescht += 1;
    }
  } catch (err) {
    console.error('Fristlöschung verworfener Kreditkartenbelege fehlgeschlagen:', err.message);
  }

  // Verwaiste finale Dokumente werden nur in Quarantaene verschoben, nie geloescht (siehe
  // services/verwaisteDateien.js). Eigener try/catch: ein Fehler hier darf die uebrigen Schritte
  // nicht als fehlgeschlagen melden.
  let quarantaene = 0;
  try {
    quarantaene = pruefeVerwaisteFinaleDateien(db, config).verschoben;
  } catch (err) {
    console.error('Pruefung verwaister finaler Dateien fehlgeschlagen:', err.message);
  }

  const ergebnis = { status: 'erfolg', archiviert, tmpGeloescht, mailLogGeloescht, kkBelegeGeloescht, quarantaene };
  logCronLauf(db, {
    job: 'pdf-bereinigung',
    gestartetAm,
    beendetAm: new Date().toISOString(),
    status: 'erfolg',
    details: `Archiviert: ${archiviert}, Tmp gelöscht: ${tmpGeloescht}, Mail-Log bereinigt: ${mailLogGeloescht}, KK-Belege gelöscht: ${kkBelegeGeloescht}, In Quarantäne: ${quarantaene}`,
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
export const runZeitstempelNachholenJob = auditedJob('zeitstempel-nachholen', runZeitstempelNachholenJobInternal);

async function runZeitstempelNachholenJobInternal(db, config) {
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
      ...tsaTrustOptions(config),
      url: tsaUrl,
      user: getConfigValue(db, 'zeitstempel_tsa_user') || undefined,
      passwort: getConfigValue(db, 'zeitstempel_tsa_passwort') || undefined,
    };

    const ausstehend = listZeitstempelAusstehendJobs(db);
    let nachgeholt = 0;
    let fehlgeschlagen = 0;
    let dateiFehlt = 0;
    for (const job of ausstehend) {
      // An issued archive manifest pins the exported revision. Never silently replace it.
      if (db.prepare('SELECT 1 FROM export_nachweise WHERE job_id = ? OR job_id = ?').get(job.id, job.aufgesplittet_von || job.id)) continue;
      // Bekannte Einschränkung (siehe Spec): sobald n8n den Job abgeholt hat, löscht das Portal
      // die lokale PDF-Datei -- ein Zeitstempel kann für diesen Job dann nicht mehr nachgeholt
      // werden. Kein Fehler, nur ein Zählwert für die Sichtbarkeit im Log.
      if (!job.pdf_pfad || !existsSync(job.pdf_pfad)) {
        dateiFehlt += 1;
        continue;
      }
      let finalPath;
      try {
        const pdfBuffer = readFileSync(job.pdf_pfad);
        const { stamped, nachweis } = await setZeitstempelMitNachweis(pdfBuffer, tsaConfig);
        finalPath = writeFinalDocument(job.pdf_pfad, stamped);
        db.exec('BEGIN IMMEDIATE');
        try {
          const current = db.prepare('SELECT * FROM jobs WHERE id = ?').get(job.id);
          if (db.prepare('SELECT 1 FROM export_nachweise WHERE job_id = ? OR job_id = ?').get(job.id, job.aufgesplittet_von || job.id)) {
            throw new Error('Dokumentversion wurde inzwischen fuer den Archivexport festgeschrieben.');
          }
          if (!current || current.status !== 'abgeschlossen' || current.abgeholt_am ||
              current.pdf_pfad !== job.pdf_pfad || current.zeitstempel_gesetzt_am ||
              !readFileSync(job.pdf_pfad).equals(pdfBuffer)) {
            throw new Error('Job oder Quelldatei wurde waehrend der Zeitstempel-Anfrage geaendert.');
          }
          const hash = createHash('sha256').update(stamped).digest('hex');
          markZeitstempelGesetzt(db, job.id, new Date().toISOString(), hash);
          speichereTsaNachweis(db, { jobId: job.id, bezug: 'einzel', dokumentSha256: hash, nachweis });
          db.prepare('UPDATE jobs SET pdf_pfad = ?, final_datei_hash = ? WHERE id = ?').run(finalPath, hash, job.id);
          db.exec('COMMIT');
        } catch (err) {
          db.exec('ROLLBACK');
          throw err;
        }
        finalPath = undefined;
        nachgeholt += 1;
      } catch (err) {
        if (finalPath) {
          try { unlinkSync(finalPath); } catch { /* Unreferenced file can be cleaned up later. */ }
        }
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
export const runDatenbankSicherungJob = auditedJob('datenbank-sicherung', runDatenbankSicherungJobInternal);

function runDatenbankSicherungJobInternal(db, config) {
  if (hasRecentRunningCronLauf(db, 'datenbank-sicherung')) {
    return { status: 'uebersprungen', meldung: 'Ein Backup-Lauf ist bereits aktiv' };
  }

  const laufId = startCronLauf(db, 'datenbank-sicherung');
  try {
    mkdirSync(config.backupDir, { recursive: true, mode: 0o700 });
    const archiv = buildEncryptedBackup(db, config);
    const dateiname = backupDateiname(new Date());
    publishEncryptedBackup(config.backupDir, dateiname, archiv);

    // Retention-Bereinigung ist absichtlich in einem eigenen try/catch isoliert (analog zu den
    // drei unabhängigen Schritten in runPdfBereinigungJob): das neue Backup ist zu diesem
    // Zeitpunkt bereits erfolgreich auf der Platte -- ein unlinkSync-Fehler beim Aufräumen alter
    // Dateien (z.B. Berechtigungsproblem) darf den gesamten Lauf nicht als 'fehler' melden, denn
    // sowohl der Scheduler (Task 6) als auch das Admin-UI (Task 7) werten `status` direkt aus.
    let bereinigt = 0;
    try {
      const aufbewahrungAnzahl = Number(getConfigValue(db, 'backup_aufbewahrung_anzahl')) || 14;
      const vorhandene = readdirSync(config.backupDir)
        .filter((name) => ENCRYPTED_BACKUP_DATEINAME_PATTERN.test(name))
        .sort();
      const zuLoeschendeAnzahl = vorhandene.length - aufbewahrungAnzahl;
      for (let i = 0; i < zuLoeschendeAnzahl; i += 1) {
        deleteBackupWithAudit(db, join(config.backupDir, vorhandene[i]), 'Automatische Backup-Retention');
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
export const runSplitGruppenNachholenJob = auditedJob('split-gruppen-nachholen', runSplitGruppenNachholenJobInternal);

async function runSplitGruppenNachholenJobInternal(db, config) {
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
      const ergebnis = await pruefeUndFinalisiereSplitGruppe(db, parent.id, config);
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

// Sammelt alle wegen aktivem Batching (admin_config['mail_batching_aktiv']) eingereihten, aber
// noch nicht versendeten mail_log-Zeilen (status = 'geplant') pro Empfänger und verschickt dafür
// eine einzige Digest-Mail. Die Zeilen werden je Empfänger beansprucht (services/mailZustellung.js),
// damit parallele Läufe nichts doppelt versenden. Scheitert der Versand, bleiben die Zeilen
// 'geplant' und der Job mail-zustellung wiederholt den Digest mit wachsendem Abstand; erst nach
// ausgeschöpften Versuchen werden sie 'fehlgeschlagen'.
export const runMailDigestJob = auditedJob('mail-digest', runMailDigestJobInternal);

async function runMailDigestJobInternal(db, config, mailer) {
  if (hasRecentRunningCronLauf(db, 'mail-digest')) {
    return { status: 'uebersprungen', versendet: 0, empfaenger: 0, meldung: 'Ein Mail-Digest-Lauf ist bereits aktiv' };
  }

  const laufId = startCronLauf(db, 'mail-digest');
  try {
    const gruppen = listGeplantMailsGruppiertNachEmpfaenger(db);

    // Die Digest-Vorlage wird einmal VOR der Empfänger-Schleife geladen und eigens abgesichert:
    // schlägt das Rendern hier fehl (fehlender/kaputter admin_config-Key), betrifft das JEDEN
    // Empfänger gleichermassen und würde sich bei jedem Lauf wiederholen. Deshalb alle aktuell
    // wartenden Zeilen sofort sichtbar auf 'fehlgeschlagen' setzen, damit sie einzeln über
    // /admin/mails' "erneut versenden" wiederholt werden können.
    let vorlage;
    try {
      vorlage = ladeDigestVorlage(db);
    } catch (err) {
      const jetzt = new Date().toISOString();
      const zeilen = [...gruppen.values()].flat();
      markiereDigestZeilenFehlgeschlagen(db, zeilen, `Digest-Vorlage konnte nicht gerendert werden: ${err.message}`);
      finishCronLauf(db, laufId, {
        beendetAm: jetzt,
        status: 'fehler',
        details: `Digest-Vorlage konnte nicht gerendert werden: ${err.message}. ${zeilen.length} wartende(s) Mail-Log-Zeile(n) auf fehlgeschlagen gesetzt.`,
      });
      return { status: 'fehler', error: err.message };
    }

    let versendet = 0;
    let fehlgeschlagen = 0;
    let wiederholung = 0;
    for (const [empfaenger, zeilen] of gruppen) {
      const status = await stelleDigestZu(db, config, mailer, { empfaenger, ids: zeilen.map((z) => z.id), vorlage });
      if (status === 'versendet') versendet += 1;
      else if (status === 'fehlgeschlagen') fehlgeschlagen += 1;
      else if (status === 'geplant') wiederholung += 1;
    }

    const fehler = fehlgeschlagen + wiederholung > 0;
    const details = `Digest-Mails versendet: ${versendet}, zur Wiederholung eingereiht: ${wiederholung}, endgültig fehlgeschlagen: ${fehlgeschlagen}, Empfänger insgesamt: ${gruppen.size}`;
    finishCronLauf(db, laufId, { beendetAm: new Date().toISOString(), status: fehler ? 'fehler' : 'erfolg', details });
    return {
      status: fehler ? 'fehler' : 'erfolg',
      versendet,
      wiederholung,
      fehlgeschlagen,
      empfaenger: gruppen.size,
      ...(fehler ? { error: details } : {}),
    };
  } catch (err) {
    finishCronLauf(db, laufId, { beendetAm: new Date().toISOString(), status: 'fehler', details: err.message });
    return { status: 'fehler', error: err.message };
  }
}

// Wiederholt fällige Einzelmails ('eingereiht') und fehlgeschlagene Digests ('geplant' mit
// Versuchen > 0) -- nach SMTP-Ausfällen und nach einem Prozessneustart. Ohne fällige Zeilen läuft
// nichts und es entsteht kein Eintrag im Cron-Verlauf/Auditprotokoll (Intervall standardmässig
// 5 Minuten). Doppelversand verhindern die Zeilensperren in services/mailZustellung.js.
const runMailZustellungJobAudited = auditedJob('mail-zustellung', runMailZustellungJobInternal);

export async function runMailZustellungJob(db, config, mailer) {
  if (!hatFaelligeMails(db)) return { status: 'uebersprungen', meldung: 'Keine fälligen Mails' };
  return runMailZustellungJobAudited(db, config, mailer);
}

async function runMailZustellungJobInternal(db, config, mailer) {
  const gestartetAm = new Date().toISOString();
  try {
    const bilanz = await stelleFaelligeMailsZu(db, config, mailer);
    const abschluss = abschlussMitBilanz(`Digest-Empfänger: ${bilanz.digestEmpfaenger}`, bilanz);
    logCronLauf(db, { job: 'mail-zustellung', gestartetAm, beendetAm: new Date().toISOString(), status: abschluss.status, details: abschluss.details });
    return { status: abschluss.status, mails: bilanz, ...(abschluss.error ? { error: abschluss.error } : {}) };
  } catch (err) {
    logCronLauf(db, { job: 'mail-zustellung', gestartetAm, beendetAm: new Date().toISOString(), status: 'fehler', details: err.message });
    return { status: 'fehler', error: err.message };
  }
}

// Erinnert an zwei getrennten Fronten (siehe Task-Brief): (1) Kreditkartenbelege, die seit
// kk_beleg_erinnerung_tage Tagen offen sind (noch keinem Job zugeordnet) -- eine Mail pro
// betroffener Person (Hochlader, Käufer, Kartenverantwortlicher), auch wenn mehrere ihrer Belege
// gleichzeitig fällig sind; und (2) markierte Kreditkartenabrechnungen, die seit ebenso langer
// Zeit auf den Abgleich (kkAbgleich.js) warten. Jede Erinnerung wird pro Beleg/Abrechnung nur
// einmal pro Intervall verschickt (letzte_erinnerung_am / kk_erinnert_am).
export const runKkBelegErinnerungenJob = auditedJob('kk-beleg-erinnerungen', runKkBelegErinnerungenJobInternal);

async function runKkBelegErinnerungenJobInternal(db, config, mailer) {
  if (getConfigValue(db, 'modul_kreditkarten_aktiv') !== '1' || getConfigValue(db, 'kk_beleg_erinnerungen_aktiv') !== '1') {
    return { status: 'uebersprungen' };
  }
  const gestartetAm = new Date().toISOString();
  try {
    const tage = tageAusConfig(db, 'kk_beleg_erinnerung_tage', 45);
    const schwelleIso = new Date(Date.now() - tage * 86400000).toISOString();
    const link = `${config.publicBaseUrl}/kreditkarte`;

    // Auswahl, Einreihen und Marker in einer Transaktion (siehe planeInTransaktion).
    const plan = planeInTransaktion(db, () => {
      const eintraege = [];
      // Pro Empfänger eine Mail mit allen Belegen, für die er zuständig ist (hochgeladen, gekauft
      // oder verantwortlich) -- sonst bekäme die verantwortliche Person pro Beleg eine eigene Mail.
      const belege = listKkBelegeFuerErinnerung(db, schwelleIso);
      const proPerson = new Map();
      for (const b of belege) {
        const zeile = `- ${b.kaufdatum || b.hochgeladen_am.slice(0, 10)} ${b.betrag ?? '?'} ${b.beschreibung || '(noch zu ergänzen)'}${b.karte_bezeichnung ? ` (${b.karte_bezeichnung})` : ''}`;
        for (const personId of new Set([b.hochgeladen_von, b.gekauft_von, b.verantwortlich_id].filter(Boolean))) {
          if (!proPerson.has(personId)) proPerson.set(personId, []);
          proPerson.get(personId).push(zeile);
        }
      }
      for (const [personId, zeilen] of proPerson) {
        const person = getPersonById(db, personId);
        if (!person || !person.aktiv) continue;
        eintraege.push(reiheBenachrichtigungEin(db, {
          to: person.email,
          typ: 'kk-beleg-erinnerung',
          jobId: null,
          variablen: { empfaengerName: `${person.vorname} ${person.nachname}`, eintraege: zeilen.join('\n'), anzahl: zeilen.length, tage, link },
        }));
      }
      for (const b of belege) markKkBelegErinnert(db, b.id);

      const abrechnungen = listKkAbrechnungenFuerErinnerung(db, schwelleIso);
      for (const job of abrechnungen) {
        const person = getPersonById(db, job.zugewiesen_an);
        if (person && person.aktiv) {
          eintraege.push(...reiheBenachrichtigungMitVertretungEin(db, {
            person,
            typ: 'kk-beleg-erinnerung',
            jobId: job.id,
            variablen: {
              eintraege: `- Abrechnung "${job.dateiname}" (${job.karte_bezeichnung}) wartet auf den Abgleich: ${config.publicBaseUrl}/kontierung/${job.id}/kk-abgleich`,
              anzahl: 1,
              tage,
              link: `${config.publicBaseUrl}/kontierung/${job.id}/kk-abgleich`,
              grund: 'Kreditkartenabrechnung wartet auf den Abgleich',
            },
          }));
        }
        markKkAbrechnungErinnert(db, job.id);
      }
      return { eintraege, belege: belege.length, abrechnungen: abrechnungen.length };
    });

    const bilanz = await stelleEintraegeZu(db, mailer, plan.eintraege);
    const abschluss = abschlussMitBilanz(`Belege: ${plan.belege}, Abrechnungen: ${plan.abrechnungen}`, bilanz);
    logCronLauf(db, { job: 'kk-beleg-erinnerungen', gestartetAm, beendetAm: new Date().toISOString(), status: abschluss.status, details: abschluss.details });
    return { status: abschluss.status, belege: plan.belege, abrechnungen: plan.abrechnungen, mails: bilanz, ...(abschluss.error ? { error: abschluss.error } : {}) };
  } catch (err) {
    logCronLauf(db, { job: 'kk-beleg-erinnerungen', gestartetAm, beendetAm: new Date().toISOString(), status: 'fehler', details: err.message });
    return { status: 'fehler', error: err.message };
  }
}
