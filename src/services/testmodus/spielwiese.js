import { existsSync, rmSync, mkdirSync, cpSync } from 'node:fs';
import { join, basename } from 'node:path';
import { openDatabase } from '../../db/index.js';
import { seedDefaults } from '../../db/adminConfigRepo.js';
import { spieleBeispieldatenEin } from './beispieldaten.js';

export function testmodusPfade(config) {
  if (!config.dbPath || config.dbPath === ':memory:') throw new Error('Der Testmodus braucht eine Datei-Datenbank (kein :memory:).');
  return {
    dbPath: `${config.dbPath}.testmodus.db`,
    jobsDir: `${config.jobsDir}-testmodus`,
    brandingDir: `${config.brandingDir}-testmodus`,
  };
}

const GEHEIM = /secret|token|pass|key/i;
const NICHT_KOPIEREN = new Set([
  'zeitstempel_tsa_url', 'zeitstempel_tsa_user', 'zeitstempel_tsa_passwort', 'monitoring_secret',
]);

export function kopierbareEinstellung(key) {
  return !GEHEIM.test(key) && !NICHT_KOPIEREN.has(key) && !key.startsWith('einrichtung_');
}

function baueTestConfig(config) {
  const pfade = testmodusPfade(config);
  return {
    ...config,
    ...pfade,
    n8nApiKey: null,
    backupApiKey: null,
    cronSecret: null,
    smtp: null,
    churchtools: {
      ...config.churchtools,
      baseUrl: 'https://testmodus.invalid',
      syncServiceToken: null,
      groupIdAdmin: 'test-admin',
      groupIdBuchhaltung: 'test-buchhaltung',
      groupIdManager: null,
    },
  };
}

function loescheDateien(pfade) {
  for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(`${pfade.dbPath}${suffix}`, { force: true });
  rmSync(pfade.jobsDir, { recursive: true, force: true });
  rmSync(pfade.brandingDir, { recursive: true, force: true });
}

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

export async function erstelleSpielwiese(echteDb, config, { neu = false } = {}) {
  const pfade = testmodusPfade(config);
  const testConfig = baueTestConfig(config);
  if (!neu) {
    const vorhanden = oeffneVorhandene(pfade);
    if (vorhanden) return { db: vorhanden, config: testConfig };
  }
  loescheDateien(pfade);
  mkdirSync(pfade.jobsDir, { recursive: true });
  mkdirSync(pfade.brandingDir, { recursive: true });
  const db = openDatabase(pfade.dbPath);
  seedDefaults(db);
  const ins = db.prepare('INSERT INTO admin_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const row of echteDb.prepare('SELECT key, value FROM admin_config').all()) {
    if (kopierbareEinstellung(row.key)) ins.run(row.key, row.value);
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

export function entferneSpielwiese(config) {
  loescheDateien(testmodusPfade(config));
}
