import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/db/index.js';

test('openDatabase creates all expected tables', () => {
  const db = openDatabase(':memory:');
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  const names = rows.map((r) => r.name);
  for (const expected of ['personen', 'sessions', 'sync_log', 'admin_config', 'konten', 'zuweisungsregeln', 'jobs', 'freigaben', 'mail_log', 'job_loeschungen', 'cron_log']) {
    assert.ok(names.includes(expected), `missing table ${expected}`);
  }
  db.close();
});

test('openDatabase is idempotent (safe to call schema twice)', () => {
  const db = openDatabase(':memory:');
  assert.doesNotThrow(() => db.exec('SELECT 1'));
  db.close();
});

test('jobs table has a thumbnail_pfad column', () => {
  const db = openDatabase(':memory:');
  const columns = db.prepare("PRAGMA table_info(jobs)").all().map((c) => c.name);
  assert.ok(columns.includes('thumbnail_pfad'), 'jobs table is missing thumbnail_pfad');
  db.close();
});

test('jobs table has the four Freigabe-Eskalation columns', () => {
  const db = openDatabase(':memory:');
  const columns = db.prepare('PRAGMA table_info(jobs)').all().map((c) => c.name);
  for (const expected of ['freigabe1_eskaliert_von', 'freigabe1_eskalationsgrund', 'freigabe2_eskaliert_von', 'freigabe2_eskalationsgrund']) {
    assert.ok(columns.includes(expected), `jobs table is missing ${expected}`);
  }
  db.close();
});

test('jobs table has betrag, zahlungsziel, rechnungsnummer and lieferant columns', () => {
  const db = openDatabase(':memory:');
  const columns = db.prepare('PRAGMA table_info(jobs)').all().map((c) => c.name);
  for (const expected of ['betrag', 'zahlungsziel', 'rechnungsnummer', 'lieferant']) {
    assert.ok(columns.includes(expected), `jobs table is missing ${expected}`);
  }
  db.close();
});

test('openDatabase adds betrag/zahlungsziel via ALTER TABLE to an existing on-disk database that predates those columns', () => {
  // Simulates the real production case: a jobs table that was created by an older schema.sql
  // (before betrag/zahlungsziel existed) and has already been running — CREATE TABLE IF NOT
  // EXISTS alone would silently no-op on it, leaving the columns missing forever.
  const dir = mkdtempSync(join(tmpdir(), 'db-migration-test-'));
  const dbPath = join(dir, 'legacy.sqlite');
  const legacyDb = new DatabaseSync(dbPath);
  legacyDb.exec(`
    CREATE TABLE jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      eingang_am TEXT NOT NULL,
      quelle TEXT NOT NULL,
      absender TEXT,
      dateiname TEXT NOT NULL,
      pdf_pfad TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'unzugewiesen'
    )
  `);
  legacyDb.close();

  const migratedDb = openDatabase(dbPath);
  const columns = migratedDb.prepare('PRAGMA table_info(jobs)').all().map((c) => c.name);
  for (const expected of ['betrag', 'zahlungsziel', 'rechnungsnummer', 'lieferant']) {
    assert.ok(columns.includes(expected), `ALTER TABLE should have added ${expected} to the pre-existing table`);
  }
  assert.doesNotThrow(() =>
    migratedDb
      .prepare('UPDATE jobs SET betrag = ?, zahlungsziel = ?, rechnungsnummer = ?, lieferant = ? WHERE id = 1')
      .run('123.45', '2026-09-01', 'RE-2026-042', 'Muster AG')
  );
  migratedDb.close();
  rmSync(dir, { recursive: true, force: true });
});

test('openDatabase rebuilds the freigaben table to widen its rolle CHECK constraint on an existing on-disk database that predates freigabe1_eskalation/freigabe2_eskalation', () => {
  // Simulates the real production case: a freigaben table created by an older schema.sql (CHECK
  // only allowing 'freigeber1'/'freigeber2'/'ablehnung') that has already been running with real
  // data in it. `CREATE TABLE IF NOT EXISTS` alone no-ops on it, and SQLite has no ALTER TABLE
  // that widens a CHECK constraint — the fix must rebuild the table without losing existing rows.
  const dir = mkdtempSync(join(tmpdir(), 'db-migration-test-'));
  const dbPath = join(dir, 'legacy.sqlite');
  const legacyDb = new DatabaseSync(dbPath);
  // node:sqlite enforces foreign keys by default, so the rebuilt freigaben table's row copy needs
  // real jobs/personen rows to reference — matching the real production case, where an
  // already-running freigaben table only ever holds rows for jobs/personen that genuinely exist.
  legacyDb.exec(`
    CREATE TABLE personen (churchtools_person_id TEXT PRIMARY KEY, vorname TEXT NOT NULL, nachname TEXT NOT NULL, email TEXT NOT NULL);
    CREATE TABLE jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, eingang_am TEXT NOT NULL, quelle TEXT NOT NULL, absender TEXT, dateiname TEXT NOT NULL, pdf_pfad TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'unzugewiesen');
    CREATE TABLE freigaben (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL REFERENCES jobs(id),
      person_id TEXT NOT NULL REFERENCES personen(churchtools_person_id),
      rolle TEXT NOT NULL CHECK (rolle IN ('freigeber1', 'freigeber2', 'ablehnung')),
      zeitpunkt TEXT NOT NULL,
      ip TEXT NOT NULL,
      interessenskonflikt INTEGER NOT NULL DEFAULT 0,
      kommentar TEXT,
      eskaliert_von TEXT REFERENCES personen(churchtools_person_id)
    );
    INSERT INTO personen (churchtools_person_id, vorname, nachname, email) VALUES ('1', 'Frei', 'Geber', 'f@example.org');
    INSERT INTO jobs (eingang_am, quelle, absender, dateiname, pdf_pfad) VALUES ('2026-08-15T08:00:00.000Z', 'scanner', NULL, 'a.pdf', '/tmp/a.pdf');
    INSERT INTO freigaben (job_id, person_id, rolle, zeitpunkt, ip, interessenskonflikt, kommentar, eskaliert_von)
      VALUES (1, '1', 'freigeber1', '2026-08-15T08:30:00.000Z', '1.2.3.4', 0, NULL, NULL);
  `);
  legacyDb.close();

  const migratedDb = openDatabase(dbPath);

  const preserved = migratedDb.prepare('SELECT * FROM freigaben WHERE id = 1').get();
  assert.equal(preserved.person_id, '1', 'existing rows must survive the table rebuild');
  assert.equal(preserved.rolle, 'freigeber1');
  assert.equal(preserved.zeitpunkt, '2026-08-15T08:30:00.000Z');

  assert.doesNotThrow(() =>
    migratedDb
      .prepare(
        `INSERT INTO freigaben (job_id, person_id, rolle, zeitpunkt, ip, interessenskonflikt, kommentar, eskaliert_von)
         VALUES (1, '1', 'freigabe1_eskalation', '2026-08-15T09:00:00.000Z', '1.2.3.4', 1, 'Befangen', NULL)`
      )
      .run(),
    'the widened CHECK constraint must accept the new escalation rolle values'
  );

  migratedDb.close();
  rmSync(dir, { recursive: true, force: true });
});

test('openDatabase is a no-op on the freigaben table when it already has the widened rolle CHECK constraint', () => {
  const dir = mkdtempSync(join(tmpdir(), 'db-migration-test-'));
  const dbPath = join(dir, 'current.sqlite');
  openDatabase(dbPath).close();
  assert.doesNotThrow(() => openDatabase(dbPath).close(), 'a second open on an already-current database must not fail');
  rmSync(dir, { recursive: true, force: true });
});
