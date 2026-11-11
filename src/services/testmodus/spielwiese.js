// Die Spielwiese (docs/testmodus.md): eine vollständig abgeschottete Kopie des Portals mit eigener Datenbank, eigenen Verzeichnissen, abgeleiteten
// Geheimnissen und ohne Zugang nach aussen (kein SMTP, kein ChurchTools, keine TSA, keine Sicherung). Die Pfade liegen NEBEN den echten (nie darin),
// damit keine echte Sicherung Testdaten enthält und der Testmodus nie echte Dateien anfasst.

import { existsSync, rmSync, mkdirSync, cpSync } from 'node:fs';
import { GRUPPEN } from '../berechtigungKatalog.js';
import { listGruppenBerechtigungen, setGruppenBerechtigungen } from '../../db/gruppenBerechtigungenRepo.js';
import { join, basename, resolve, relative, isAbsolute } from 'node:path';
import { createHmac } from 'node:crypto';
import { openDatabase } from '../../db/index.js';
import { seedDefaults } from '../../db/adminConfigRepo.js';
import { spieleBeispieldatenEin } from './beispieldaten.js';

// Absolut und ohne Schrägstrich am Ende: aus JOBS_DIR=/data/jobs/ würde sonst /data/jobs/-testmodus,
// also ein Verzeichnis IN den echten Belegen (und damit in jeder echten Sicherung).
function normalisiert(pfad, name) {
  if (!pfad) throw new Error(`Der Testmodus braucht ${name}.`);
  return resolve(String(pfad)).replace(/(?<=.)[\\/]+$/, '');
}

const liegtIn = (innen, aussen) => {
  const rel = relative(aussen, innen);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

// Berechnet die Pfade der Spielwiese und prüft, dass keiner im echten Belegverzeichnis liegt. @returns {{dbPath, jobsDir, brandingDir, backupDir}}
export function testmodusPfade(config) {
  if (!config.dbPath || config.dbPath === ':memory:') throw new Error('Der Testmodus braucht eine Datei-Datenbank (kein :memory:).');
  const dbPath = normalisiert(config.dbPath, 'DB_PATH');
  const jobsDir = normalisiert(config.jobsDir, 'JOBS_DIR');
  const brandingDir = normalisiert(config.brandingDir, 'BRANDING_DIR');
  const pfade = {
    dbPath: `${dbPath}.testmodus.db`,
    jobsDir: `${jobsDir}-testmodus`,
    brandingDir: `${brandingDir}-testmodus`,
    backupDir: `${dbPath}.testmodus-backups`,
  };
  for (const abgeleitet of Object.values(pfade)) {
    for (const echt of [jobsDir, brandingDir]) {
      if (liegtIn(abgeleitet, echt)) throw new Error(`Testmodus-Pfad ${abgeleitet} läge im echten Verzeichnis ${echt}.`);
    }
  }
  return pfade;
}

const GEHEIM = /secret|token|pass|key/i;
// Einstellungen, die nicht aus der echten App in die Spielwiese kopiert werden (Geheimnisse, TSA, Wartungsmodus, Einrichtungsstand).
const NICHT_KOPIEREN = new Set([
  'zeitstempel_tsa_url', 'zeitstempel_tsa_user', 'zeitstempel_tsa_passwort', 'monitoring_secret',
  'testmodus_bereit',
  // Der Wartungsmodus der echten App gilt nicht für die Spielwiese.
  'wartungsmodus_aktiv', 'wartungsmodus_hinweis',
]);

// true, wenn der Schlüssel in die Spielwiese kopiert werden darf.
export function kopierbareEinstellung(key) {
  return !GEHEIM.test(key) && !NICHT_KOPIEREN.has(key) && !key.startsWith('einrichtung_');
}

// Eigenes Geheimnis je Zweck: Signaturen und CSRF-Tokens der Test-Instanz gelten nie in der echten App.
function ableiten(geheimnis, zweck) {
  return createHmac('sha256', String(geheimnis ?? '')).update(`testmodus:${zweck}`).digest('hex');
}

// TSA-Zugang bleibt in der Spiel-DB immer leer, egal welcher Schreibweg ihn setzt.
const TSA_SCHLUESSEL = "('zeitstempel_tsa_url', 'zeitstempel_tsa_user', 'zeitstempel_tsa_passwort')";
// Sorgt dafür, dass die TSA-Einstellungen in der Spiel-Datenbank leer bleiben (Trigger für Insert und Update).
function sichereSpielDb(db) {
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS testmodus_kein_tsa_insert AFTER INSERT ON admin_config
      WHEN NEW.key IN ${TSA_SCHLUESSEL} AND NEW.value IS NOT ''
      BEGIN UPDATE admin_config SET value = '' WHERE key = NEW.key; END;
    CREATE TRIGGER IF NOT EXISTS testmodus_kein_tsa_update AFTER UPDATE ON admin_config
      WHEN NEW.key IN ${TSA_SCHLUESSEL} AND NEW.value IS NOT ''
      BEGIN UPDATE admin_config SET value = '' WHERE key = NEW.key; END;
    UPDATE admin_config SET value = '' WHERE key IN ${TSA_SCHLUESSEL} AND value IS NOT '';
  `);
}

// Test-Konfiguration: abgeleitete Geheimnisse, keine Schlüssel/SMTP/Cron, ChurchTools-Attrappe mit Testgruppen.
function baueTestConfig(config) {
  const pfade = testmodusPfade(config);
  return {
    ...config,
    ...pfade,
    testmodus: true,
    sessionSecret: ableiten(config.sessionSecret, 'sitzung'),
    downloadSigningSecret: ableiten(config.downloadSigningSecret, 'download'),
    backupKeyringFile: null,
    tsaCrlFile: null,
    tsaCrlAutoUpdate: false,
    n8nApiKey: null,
    backupApiKey: null,
    cronSecret: null,
    smtp: null,
    churchtools: {
      ...config.churchtools,
      baseUrl: 'https://testmodus.invalid',
      testmodus: true,
      clientSecret: null,
      syncServiceToken: null,
      groupIdAdmin: 'test-admin',
      groupIdBuchhaltung: 'test-buchhaltung',
      groupIdManager: null,
    },
  };
}

// Löscht Spiel-Datenbank und -Verzeichnisse.
function loescheDateien(pfade) {
  for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(`${pfade.dbPath}${suffix}`, { force: true });
  rmSync(pfade.jobsDir, { recursive: true, force: true });
  rmSync(pfade.brandingDir, { recursive: true, force: true });
  rmSync(pfade.backupDir, { recursive: true, force: true });
}

// Öffnet eine vorhandene, vollständig aufgebaute Spiel-Datenbank (Marker `testmodus_bereit`), sonst null.
function oeffneVorhandene(pfade) {
  if (!existsSync(pfade.dbPath)) return null;
  let db;
  try {
    db = openDatabase(pfade.dbPath);
    const bereit = db.prepare("SELECT value FROM admin_config WHERE key = 'testmodus_bereit'").get();
    if (bereit?.value !== '1') throw new Error('unvollständig');
    return db;
  } catch {
    try { db?.close(); } catch { /* ignorieren */ }
    return null;
  }
}

// Öffnet die vorhandene Spielwiese oder baut eine neue (mit `neu: true` immer neu): Einstellungen und Gruppenrechte werden aus der echten App kopiert,
// Beispieldaten eingespielt. @returns {Promise<{db, config}>}
export async function erstelleSpielwiese(echteDb, config, { neu = false } = {}) {
  const pfade = testmodusPfade(config);
  const testConfig = baueTestConfig(config);
  if (!neu) {
    const vorhanden = oeffneVorhandene(pfade);
    if (vorhanden) {
      // Nach einem App-Update fehlen sonst neue Standardwerte (ON CONFLICT DO NOTHING: eigene Werte bleiben).
      seedDefaults(vorhanden);
      sichereSpielDb(vorhanden);
      return { db: vorhanden, config: testConfig };
    }
  }
  loescheDateien(pfade);
  mkdirSync(pfade.jobsDir, { recursive: true });
  mkdirSync(pfade.brandingDir, { recursive: true });
  const db = openDatabase(pfade.dbPath);
  seedDefaults(db);
  sichereSpielDb(db);
  const ins = db.prepare('INSERT INTO admin_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const row of echteDb.prepare('SELECT key, value FROM admin_config').all()) {
    if (kopierbareEinstellung(row.key)) ins.run(row.key, row.value);
  }
  // Gruppenrechte der echten App übernehmen, damit die Beispielpersonen die konfigurierten Rechte zeigen.
  for (const gruppe of GRUPPEN) {
    setGruppenBerechtigungen(db, gruppe, listGruppenBerechtigungen(echteDb, gruppe));
  }
  if (config.brandingDir && existsSync(config.brandingDir)) {
    cpSync(config.brandingDir, pfade.brandingDir, { recursive: true });
  }
  // Logo-Pfade auf die Kopie umbiegen, sonst würde der Testmodus echte Dateien anfassen.
  const cfg = (k) => db.prepare('SELECT value FROM admin_config WHERE key = ?').get(k)?.value;
  for (const [pfadKey, mimeKey] of [['branding_logo_pfad', 'branding_logo_mimetype'], ['branding_logo_dunkel_pfad', 'branding_logo_dunkel_mimetype']]) {
    const alt = cfg(pfadKey);
    if (!alt) continue;
    const neuPfad = join(pfade.brandingDir, basename(alt));
    if (existsSync(neuPfad)) ins.run(pfadKey, neuPfad);
    else db.prepare('DELETE FROM admin_config WHERE key IN (?, ?)').run(pfadKey, mimeKey);
  }
  await spieleBeispieldatenEin(db, testConfig);
  ins.run('testmodus_bereit', '1');
  return { db, config: testConfig };
}

// Löscht die Spielwiese vollständig.
export function entferneSpielwiese(config) {
  loescheDateien(testmodusPfade(config));
}
