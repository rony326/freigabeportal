import nodeFs from 'node:fs';
import { resolve, dirname, sep } from 'node:path';
import { fetchGroup, fetchGroupMemberIds } from './churchtools.js';
import { sendRenderedMail } from './notify.js';
import { runSyncPersonenJob, runPoolErinnerungenJob, runMailZustellungJob } from './cronJobs.js';

// Technische Prüfungen und Tests der Ersteinrichtung. Es werden nie Werte von Umgebungsvariablen
// oder Geheimnisse ausgegeben, nur Status und ein kurzer Hinweis.

const SPEICHER = [
  { name: 'Speicherort Datenbank', feld: 'dbPath', datei: true },
  { name: 'Speicherort Belege', feld: 'jobsDir' },
  { name: 'Speicherort Erscheinungsbild', feld: 'brandingDir' },
  { name: 'Speicherort Sicherungen', feld: 'backupDir' },
];

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

function pruefeSpeicher(config, anwendungsVerzeichnis, fs, { name, feld, datei }) {
  const wert = config[feld];
  if (!wert) return { name, status: 'fehlt', hinweis: 'Nicht eingestellt.' };
  const pfad = resolve(wert);
  if (!beschreibbar(fs, datei ? dirname(pfad) : pfad)) {
    return { name, status: 'ungültig', hinweis: 'Der Speicherort ist nicht beschreibbar.' };
  }
  const app = resolve(anwendungsVerzeichnis);
  if (pfad === app || pfad.startsWith(app.endsWith(sep) ? app : app + sep)) {
    return { name, status: 'warnung', hinweis: 'Liegt im Anwendungsverzeichnis und wird beim nächsten Deploy überschrieben. Bitte ein Verzeichnis ausserhalb verwenden.' };
  }
  return { name, status: 'ok', hinweis: 'Beschreibbar.' };
}

export function pruefeTechnik(config, { anwendungsVerzeichnis = process.cwd(), fs = nodeFs } = {}) {
  const pruefungen = [];
  pruefungen.push({ name: 'Pflichteinstellungen', status: 'ok', hinweis: 'Alle Pflichtvariablen sind gesetzt (beim Start geprüft).' });

  const url = String(config.publicBaseUrl || '');
  pruefungen.push(!url
    ? { name: 'Öffentliche Adresse', status: 'fehlt', hinweis: 'Nicht eingestellt.' }
    : url.startsWith('https://')
      ? { name: 'Öffentliche Adresse', status: 'ok', hinweis: 'Verschlüsselt (https).' }
      : { name: 'Öffentliche Adresse', status: 'warnung', hinweis: 'Beginnt nicht mit https://. Im Betrieb sollte die Adresse verschlüsselt sein.' });

  for (const s of SPEICHER) pruefungen.push(pruefeSpeicher(config, anwendungsVerzeichnis, fs, s));

  pruefungen.push({ name: 'Backup-Schlüssel', status: 'ok', hinweis: config.backupApiKey ? 'Gesetzt.' : 'Nicht gesetzt (optional).' });
  pruefungen.push({ name: 'Manager-Gruppe', status: 'ok', hinweis: config.churchtools?.groupIdManager ? 'Gesetzt.' : 'Nicht gesetzt (optional).' });
  if (!config.tsaTrustAnchorsFile) {
    pruefungen.push({ name: 'Zeitstempel-Vertrauensanker', status: 'ok', hinweis: 'Nicht gesetzt (optional).' });
  } else {
    let lesbar = true;
    try { fs.accessSync(config.tsaTrustAnchorsFile, nodeFs.constants.R_OK); } catch { lesbar = false; }
    pruefungen.push(lesbar
      ? { name: 'Zeitstempel-Vertrauensanker', status: 'ok', hinweis: 'Datei vorhanden.' }
      : { name: 'Zeitstempel-Vertrauensanker', status: 'ungültig', hinweis: 'Die eingestellte Datei ist nicht lesbar.' });
  }
  return pruefungen;
}

export async function testeChurchtools(config) {
  const ct = config.churchtools;
  const token = ct.syncServiceToken;
  const rollen = [['Buchhaltung', ct.groupIdBuchhaltung], ['Admin', ct.groupIdAdmin], ['Manager', ct.groupIdManager]].filter(([, id]) => id);
  try {
    const gruppen = [];
    for (const [rolle, id] of rollen) {
      const gruppe = await fetchGroup(ct, token, id);
      const mitglieder = (await fetchGroupMemberIds(ct, token, id)).length;
      gruppen.push({ rolle, id: String(id), name: gruppe.name, mitglieder });
    }
    return { ok: true, gruppen };
  } catch (err) {
    // Meldung bewusst fest formuliert: Fehlertexte könnten Adressen oder Zugangsdaten enthalten.
    const meldung = err.status === 401 || err.status === 403
      ? 'ChurchTools lehnt den Zugang ab. Bitte den Dienst-Token prüfen.'
      : err.status === 404
        ? 'Eine der Gruppen wurde in ChurchTools nicht gefunden. Bitte die Gruppen-IDs prüfen.'
        : err.status
          ? `ChurchTools antwortet mit einem Fehler (${err.status}).`
          : 'ChurchTools ist nicht erreichbar. Bitte die Adresse prüfen.';
    return { ok: false, meldung };
  }
}

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
  return res.status === 'versendet'
    ? { status: 'versendet', meldung: 'Die Testmail wurde verschickt.' }
    : { status: res.status, meldung: 'Die Testmail konnte nicht zugestellt werden. Bitte die Mail-Einstellungen prüfen.' };
}

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
