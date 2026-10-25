import nodeFs from 'node:fs';
import { resolve, dirname, basename, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchGroup, fetchGroupMemberIds } from './churchtools.js';
import { sendRenderedMail } from './notify.js';
import { runSyncPersonenJob, runPoolErinnerungenJob, runMailZustellungJob } from './cronJobs.js';
import { loadBackupKeyring } from './backupEnvelope.js';

// Technische Prüfungen und Tests der Ersteinrichtung. Es werden nie Werte von Umgebungsvariablen
// oder Geheimnisse ausgegeben, nur Status und ein kurzer Hinweis.

// Wurzel der Anwendung (Elternverzeichnis von src), unabhängig vom Arbeitsverzeichnis des Prozesses.
export const ANWENDUNGSVERZEICHNIS = fileURLToPath(new URL('../../', import.meta.url));

const HOSTER = 'Bitte beim Hoster eintragen (z. B. Infomaniak: Site-Konfiguration → Umgebungsvariablen).';
const liste = (namen) => (namen.length > 1 ? `${namen.slice(0, -1).join(', ')} und ${namen.at(-1)}` : namen[0]);

const SPEICHER = [
  { name: 'Speicherort Datenbank', feld: 'dbPath', datei: true, variable: 'DB_PATH' },
  { name: 'Speicherort Belege', feld: 'jobsDir', variable: 'JOBS_DIR' },
  { name: 'Speicherort Erscheinungsbild', feld: 'brandingDir', variable: 'BRANDING_DIR' },
  { name: 'Speicherort Sicherungen', feld: 'backupDir', variable: 'BACKUP_DIR' },
];

const SMTP_VARIABLEN = [['SMTP_HOST', 'host'], ['SMTP_USER', 'user'], ['SMTP_PASS', 'pass'], ['SMTP_FROM', 'from']];

// Nur ob die Variablen gesetzt sind, nie deren Werte.
function pruefeMailserver(config) {
  const fehlend = SMTP_VARIABLEN.filter(([, feld]) => !String(config.smtp?.[feld] ?? '').trim()).map(([v]) => v);
  const zeile = { name: 'Mailserver', anker: 'mailserver' };
  if (!fehlend.length) return { ...zeile, status: 'ok', hinweis: `${liste(SMTP_VARIABLEN.map(([v]) => v))} sind gesetzt.` };
  return { ...zeile, status: 'fehlt', hinweis: `Es fehlt: ${liste(fehlend)}. Ohne diese Angaben verschickt das Portal keine Mails. ${HOSTER}` };
}

// Schlüsselbund für die verschlüsselten Sicherungen: vorhanden, lesbar und gültig.
function pruefeKeyring(config, fs, ladeKeyring) {
  const name = 'Backup-Schlüsselbund';
  if (!config.backupKeyringFile) {
    return { name, status: 'fehlt', hinweis: `BACKUP_KEYRING_FILE ist nicht gesetzt. Ohne Schlüsselbund werden keine Sicherungen erstellt. ${HOSTER}` };
  }
  try { fs.accessSync(config.backupKeyringFile, nodeFs.constants.R_OK); } catch {
    return { name, status: 'ungültig', hinweis: `Die Datei aus BACKUP_KEYRING_FILE ist nicht lesbar. Bitte den Pfad prüfen. ${HOSTER}` };
  }
  try { ladeKeyring(config); } catch {
    return { name, status: 'ungültig', hinweis: 'Die Datei aus BACKUP_KEYRING_FILE ist kein gültiger Schlüsselbund. Nötig: eigene Datei ausserhalb der Datenverzeichnisse, nur für den Server lesbar (Rechte 0600 oder 0400), gültiges Format.' };
  }
  return { name, status: 'ok', hinweis: 'BACKUP_KEYRING_FILE ist gesetzt, die Datei ist lesbar und gültig.' };
}

// Nächstes vorhandenes Verzeichnis oberhalb des Pfads: dort muss geschrieben werden können.
function beschreibbar(fs, pfad) {
  let aktuell = pfad;
  while (!fs.existsSync(aktuell)) {
    const eltern = dirname(aktuell);
    if (eltern === aktuell) return false;
    aktuell = eltern;
  }
  try {
    fs.accessSync(aktuell, nodeFs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

// Symlinks auflösen: vom tiefsten vorhandenen Vorfahren aus, der Rest wird unverändert angehängt.
function echterPfad(fs, pfad) {
  const rest = [];
  let aktuell = pfad;
  while (!fs.existsSync(aktuell)) {
    const eltern = dirname(aktuell);
    if (eltern === aktuell) return pfad;
    rest.unshift(basename(aktuell));
    aktuell = eltern;
  }
  try {
    return resolve((fs.realpathSync || nodeFs.realpathSync)(aktuell), ...rest);
  } catch {
    return pfad;
  }
}

function pruefeSpeicher(config, anwendungsVerzeichnis, fs, s) {
  const r = pruefeSpeicherOrt(config, anwendungsVerzeichnis, fs, s);
  return r.status === 'ok' ? r : { ...r, hinweis: `${r.hinweis} Einstellung: ${s.variable}. ${HOSTER}` };
}

function pruefeSpeicherOrt(config, anwendungsVerzeichnis, fs, { name, feld, datei }) {
  const wert = config[feld];
  if (!wert) return { name, status: 'fehlt', hinweis: 'Nicht eingestellt.' };
  const roh = resolve(wert);
  const zuPruefen = datei ? dirname(roh) : roh;
  if (fs.existsSync(zuPruefen) && !fs.statSync(zuPruefen).isDirectory()) {
    return { name, status: 'ungültig', hinweis: 'Der Speicherort ist kein Verzeichnis.' };
  }
  if (!beschreibbar(fs, zuPruefen)) {
    return { name, status: 'ungültig', hinweis: 'Der Speicherort ist nicht beschreibbar.' };
  }
  const pfad = echterPfad(fs, roh);
  const app = echterPfad(fs, resolve(anwendungsVerzeichnis));
  if (pfad === app || pfad.startsWith(app.endsWith(sep) ? app : app + sep)) {
    return { name, status: 'warnung', hinweis: 'Liegt im Anwendungsverzeichnis und wird beim nächsten Deploy überschrieben. Bitte ein Verzeichnis ausserhalb verwenden.' };
  }
  return { name, status: 'ok', hinweis: 'Beschreibbar.' };
}

export function pruefeTechnik(config, { anwendungsVerzeichnis = ANWENDUNGSVERZEICHNIS, fs = nodeFs, ladeKeyring = loadBackupKeyring } = {}) {
  const pruefungen = [];
  pruefungen.push({ name: 'Pflichteinstellungen', status: 'ok', hinweis: 'Alle Pflichtvariablen sind gesetzt (beim Start geprüft).' });

  const url = String(config.publicBaseUrl || '');
  pruefungen.push(!url
    ? { name: 'Öffentliche Adresse', status: 'fehlt', hinweis: `PUBLIC_BASE_URL ist nicht gesetzt. ${HOSTER}` }
    : url.startsWith('https://')
      ? { name: 'Öffentliche Adresse', status: 'ok', hinweis: 'Verschlüsselt (https).' }
      : { name: 'Öffentliche Adresse', status: 'warnung', hinweis: `Beginnt nicht mit https://. Im Betrieb sollte die Adresse verschlüsselt sein. Einstellung: PUBLIC_BASE_URL. ${HOSTER}` });

  for (const s of SPEICHER) pruefungen.push(pruefeSpeicher(config, anwendungsVerzeichnis, fs, s));

  pruefungen.push(pruefeMailserver(config));
  pruefungen.push(pruefeKeyring(config, fs, ladeKeyring));
  pruefungen.push({ name: 'Backup-Download-Schlüssel (optional)', status: 'ok', hinweis: config.backupApiKey
    ? 'BACKUP_API_KEY ist gesetzt.'
    : 'BACKUP_API_KEY ist nicht gesetzt (optional, nur für das automatische Abholen der Sicherungen durch n8n).' });
  pruefungen.push({ name: 'Manager-Gruppe', status: 'ok', hinweis: config.churchtools?.groupIdManager ? 'CT_GROUP_ID_MANAGER ist gesetzt.' : 'CT_GROUP_ID_MANAGER ist nicht gesetzt (optional).' });
  if (!config.tsaTrustAnchorsFile) {
    pruefungen.push({ name: 'Zeitstempel-Vertrauensanker', status: 'ok', hinweis: 'TSA_TRUST_ANCHORS_FILE ist nicht gesetzt (optional, aber nötig, wenn ein Zeitstempeldienst genutzt wird).' });
  } else {
    let lesbar = true;
    try { fs.accessSync(config.tsaTrustAnchorsFile, nodeFs.constants.R_OK); } catch { lesbar = false; }
    pruefungen.push(lesbar
      ? { name: 'Zeitstempel-Vertrauensanker', status: 'ok', hinweis: 'Datei aus TSA_TRUST_ANCHORS_FILE vorhanden.' }
      : { name: 'Zeitstempel-Vertrauensanker', status: 'ungültig', hinweis: `Die Datei aus TSA_TRUST_ANCHORS_FILE ist nicht lesbar. ${HOSTER}` });
  }
  return pruefungen;
}

export async function testeChurchtools(config, { timeoutMs = 10000 } = {}) {
  const ct = config.churchtools;
  const token = ct.syncServiceToken;
  const rollen = [['Buchhaltung', ct.groupIdBuchhaltung], ['Admin', ct.groupIdAdmin], ['Manager', ct.groupIdManager]].filter(([, id]) => id);
  try {
    const gruppen = [];
    for (const [rolle, id] of rollen) {
      // Jede Anfrage bricht nach dem Zeitlimit ab, damit die Seite nie hängen bleibt.
      const gruppe = await fetchGroup(ct, token, id, { signal: AbortSignal.timeout(timeoutMs) });
      const mitglieder = (await fetchGroupMemberIds(ct, token, id, { signal: AbortSignal.timeout(timeoutMs) })).length;
      gruppen.push({ rolle, id: String(id), name: gruppe.name, mitglieder });
    }
    return { ok: true, gruppen };
  } catch (err) {
    // Meldung bewusst fest formuliert: Fehlertexte könnten Adressen oder Zugangsdaten enthalten.
    const zeitlimit = err.name === 'TimeoutError' || err.name === 'AbortError' || err.cause?.name === 'TimeoutError';
    const meldung = zeitlimit
      ? 'ChurchTools antwortet nicht'
      : err.status === 401 || err.status === 403
      ? 'ChurchTools lehnt den Zugang ab. Bitte den Dienst-Token prüfen.'
      : err.status === 404
        ? 'Eine der Gruppen wurde in ChurchTools nicht gefunden. Bitte die Gruppen-IDs prüfen.'
        : err.status
          ? `ChurchTools antwortet mit einem Fehler (${err.status}).`
          : 'ChurchTools ist nicht erreichbar. Bitte die Adresse prüfen.';
    return { ok: false, meldung };
  }
}

const SIEHE_MAILSERVER = 'Bitte die Einstellungen des Mailservers prüfen (siehe Technische Grundlagen → Mailserver).';

export async function sendeTestmail(db, mailer, { person }) {
  const to = (person?.email || '').trim();
  if (!to) return { status: 'fehlgeschlagen', meldung: 'Für dein Konto ist keine E-Mail-Adresse hinterlegt.' };
  const res = await sendRenderedMail(db, mailer, {
    to,
    subject: 'Testmail vom Freigabeportal',
    text: 'Dies ist eine Testmail vom Freigabeportal. Wenn du sie liest, funktioniert der E-Mail-Versand.',
    typ: 'testmail',
    jobId: null,
  });
  if (res.status === 'versendet') return { status: 'versendet', meldung: 'Die Testmail wurde verschickt.' };
  if (res.status === 'eingereiht') return { status: 'eingereiht', meldung: `Die Testmail konnte noch nicht zugestellt werden, das Portal versucht es erneut. ${SIEHE_MAILSERVER}` };
  return { status: res.status, meldung: `Die Testmail konnte nicht zugestellt werden. ${SIEHE_MAILSERVER}` };
}

// Anzeige im Assistenten: deutsche Namen statt Job-IDs, verständlicher Status.
export const JOB_NAMEN = { 'sync-personen': 'Personen-Abgleich', 'pool-erinnerungen': 'Erinnerungen', 'mail-zustellung': 'Mailzustellung' };
const JOB_STATUS = { erfolg: 'erfolgreich', fehler: 'fehlgeschlagen', uebersprungen: 'nichts zu tun', abgebrochen: 'abgebrochen', unbekannt: 'unbekannt' };
export const jobStatusText = (status) => JOB_STATUS[status] || status;

const KERNJOBS = {
  'sync-personen': runSyncPersonenJob,
  'pool-erinnerungen': runPoolErinnerungenJob,
  'mail-zustellung': runMailZustellungJob,
};

// Dieselben Funktionen wie die "jetzt ausführen"-Routen unter /admin/geplante-jobs.
export async function loeseKernjobsAus(db, config, mailer, jobs) {
  const ergebnis = [];
  for (const job of jobs) {
    const fn = KERNJOBS[job];
    if (!fn) { ergebnis.push({ job, status: 'unbekannt' }); continue; }
    try {
      const r = await fn(db, config, mailer);
      ergebnis.push({ job, status: r?.status || 'erfolg' });
    } catch {
      ergebnis.push({ job, status: 'fehler' });
    }
  }
  return ergebnis;
}
