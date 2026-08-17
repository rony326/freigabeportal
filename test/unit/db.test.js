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
