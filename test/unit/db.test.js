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
  for (const expected of ['personen', 'sessions', 'sync_log', 'admin_config', 'konten', 'zuweisungsregeln', 'jobs', 'freigaben', 'mail_log', 'job_loeschungen', 'cron_log', 'backup_wiederherstellungen']) {
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

test('jobs table has a zeitstempel_gesetzt_am column', () => {
  const db = openDatabase(':memory:');
  const columns = db.prepare('PRAGMA table_info(jobs)').all().map((c) => c.name);
  assert.ok(columns.includes('zeitstempel_gesetzt_am'), 'jobs table is missing zeitstempel_gesetzt_am');
  db.close();
});

test('jobs table has an abgeschlossen_am column', () => {
  const db = openDatabase(':memory:');
  const columns = db.prepare('PRAGMA table_info(jobs)').all().map((c) => c.name);
  assert.ok(columns.includes('abgeschlossen_am'), 'jobs table is missing abgeschlossen_am');
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

test('openDatabase rebuilds the cron_log table to widen its job/status CHECK constraints on an existing on-disk database that predates zeitstempel-nachholen', () => {
  // Simulates the real production case: a cron_log table created by an older schema.sql (job
  // CHECK only allowing 'pool-erinnerungen'/'pdf-bereinigung', status only 'erfolg'/'fehler',
  // beendet_am NOT NULL) that has already been running with real rows in it. `CREATE TABLE IF NOT
  // EXISTS` alone no-ops on it and SQLite cannot widen a CHECK constraint via ALTER TABLE, so
  // startCronLauf('zeitstempel-nachholen') would fail forever on such a database — the migration
  // has to rebuild the table without losing the existing log history. Every other test in the
  // suite opens ':memory:', where schema.sql already creates the new shape and
  // migrateCronLogTable early-returns, so this on-disk case is the only place its body runs.
  const dir = mkdtempSync(join(tmpdir(), 'db-migration-test-'));
  const dbPath = join(dir, 'legacy.sqlite');
  const legacyDb = new DatabaseSync(dbPath);
  legacyDb.exec(`
    CREATE TABLE cron_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job TEXT NOT NULL CHECK(job IN ('pool-erinnerungen', 'pdf-bereinigung')),
      gestartet_am TEXT NOT NULL,
      beendet_am TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('erfolg', 'fehler')),
      details TEXT
    );
    INSERT INTO cron_log (job, gestartet_am, beendet_am, status, details)
      VALUES ('pool-erinnerungen', '2026-08-15T08:00:00.000Z', '2026-08-15T08:00:05.000Z', 'erfolg', 'Reminder: 2, Eskalation: 0');
  `);
  legacyDb.close();

  const migratedDb = openDatabase(dbPath);

  const preserved = migratedDb.prepare('SELECT * FROM cron_log WHERE id = 1').get();
  assert.ok(preserved, 'existing rows must survive the table rebuild');
  assert.equal(preserved.job, 'pool-erinnerungen');
  assert.equal(preserved.gestartet_am, '2026-08-15T08:00:00.000Z');
  assert.equal(preserved.beendet_am, '2026-08-15T08:00:05.000Z');
  assert.equal(preserved.status, 'erfolg');
  assert.equal(preserved.details, 'Reminder: 2, Eskalation: 0');

  assert.doesNotThrow(
    () =>
      migratedDb
        .prepare("INSERT INTO cron_log (job, gestartet_am, beendet_am, status, details) VALUES ('zeitstempel-nachholen', '2026-08-15T09:00:00.000Z', NULL, 'laufend', NULL)")
        .run(),
    'the widened CHECK constraints (and the now-nullable beendet_am) must accept a running zeitstempel-nachholen entry'
  );

  assert.equal(migratedDb.prepare('SELECT COUNT(*) AS anzahl FROM cron_log').get().anzahl, 2);
  assert.equal(
    migratedDb.prepare("SELECT COUNT(*) AS anzahl FROM sqlite_master WHERE type = 'table' AND name = 'cron_log_pre_zeitstempel_nachholen'").get().anzahl,
    0,
    'the renamed-aside table must be dropped once its rows have been copied across'
  );

  migratedDb.close();
  rmSync(dir, { recursive: true, force: true });
});

test('openDatabase is a no-op on the cron_log table when it already has the widened CHECK constraints', () => {
  const dir = mkdtempSync(join(tmpdir(), 'db-migration-test-'));
  const dbPath = join(dir, 'current.sqlite');
  const first = openDatabase(dbPath);
  first.prepare("INSERT INTO cron_log (job, gestartet_am, beendet_am, status, details) VALUES ('zeitstempel-nachholen', '2026-08-15T09:00:00.000Z', NULL, 'laufend', NULL)").run();
  first.close();

  const second = openDatabase(dbPath);
  assert.equal(second.prepare('SELECT COUNT(*) AS anzahl FROM cron_log').get().anzahl, 1, 'a second open must not rebuild (and must not lose) an already-current cron_log');
  second.close();
  rmSync(dir, { recursive: true, force: true });
});

test('openDatabase backfills abgeschlossen_am for jobs that were already abgeschlossen before the column existed, and leaves other statuses NULL', () => {
  // Simulates the deploy-day case for the RFC3161 feature: a database with jobs that reached
  // 'abgeschlossen' before abgeschlossen_am existed. The n8n pickup gate blocks every
  // abgeschlossen job without a timestamp, while the admin warning banner
  // (countZeitstempelUeberfaellig) skips rows with abgeschlossen_am IS NULL — so without this
  // backfill those jobs would be un-pickupable by n8n with nothing on the dashboard saying why.
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
    );
    INSERT INTO jobs (eingang_am, quelle, absender, dateiname, pdf_pfad, status)
      VALUES ('2026-08-15T08:00:00.000Z', 'scanner', NULL, 'fertig.pdf', '/tmp/fertig.pdf', 'abgeschlossen');
    INSERT INTO jobs (eingang_am, quelle, absender, dateiname, pdf_pfad, status)
      VALUES ('2026-08-15T08:00:00.000Z', 'scanner', NULL, 'offen.pdf', '/tmp/offen.pdf', 'freigabe2');
  `);
  legacyDb.close();

  const migratedDb = openDatabase(dbPath);

  const columns = migratedDb.prepare('PRAGMA table_info(jobs)').all().map((c) => c.name);
  assert.ok(columns.includes('abgeschlossen_am'), 'ALTER TABLE should have added abgeschlossen_am to the pre-existing table');

  const abgeschlossen = migratedDb.prepare("SELECT * FROM jobs WHERE dateiname = 'fertig.pdf'").get();
  assert.ok(abgeschlossen.abgeschlossen_am, 'a job that was already abgeschlossen must be backfilled with a non-null abgeschlossen_am');
  assert.ok(!Number.isNaN(Date.parse(abgeschlossen.abgeschlossen_am)), 'the backfilled value must be a parseable ISO timestamp');

  const offen = migratedDb.prepare("SELECT * FROM jobs WHERE dateiname = 'offen.pdf'").get();
  assert.equal(offen.abgeschlossen_am, null, 'a job that is not abgeschlossen must keep abgeschlossen_am NULL');

  migratedDb.close();

  // Idempotence: re-opening must not rewrite the already-backfilled value (only NULL rows match).
  const reopened = openDatabase(dbPath);
  assert.equal(
    reopened.prepare("SELECT abgeschlossen_am FROM jobs WHERE dateiname = 'fertig.pdf'").get().abgeschlossen_am,
    abgeschlossen.abgeschlossen_am,
    're-running the migration must leave an already-backfilled abgeschlossen_am untouched'
  );
  assert.equal(reopened.prepare("SELECT abgeschlossen_am FROM jobs WHERE dateiname = 'offen.pdf'").get().abgeschlossen_am, null);
  reopened.close();

  rmSync(dir, { recursive: true, force: true });
});

test('openDatabase is a no-op on the freigaben table when it already has the widened rolle CHECK constraint', () => {
  const dir = mkdtempSync(join(tmpdir(), 'db-migration-test-'));
  const dbPath = join(dir, 'current.sqlite');
  openDatabase(dbPath).close();
  assert.doesNotThrow(() => openDatabase(dbPath).close(), 'a second open on an already-current database must not fail');
  rmSync(dir, { recursive: true, force: true });
});

test('jobs table has the six qr_* columns', () => {
  const db = openDatabase(':memory:');
  const columns = db.prepare('PRAGMA table_info(jobs)').all().map((c) => c.name);
  for (const expected of ['qr_iban', 'qr_referenz', 'qr_betrag', 'qr_waehrung', 'qr_creditor_name', 'qr_erkannt_am']) {
    assert.ok(columns.includes(expected), `jobs table is missing ${expected}`);
  }
  db.close();
});

test('openDatabase adds the qr_* columns via ALTER TABLE to an existing on-disk database that predates them', () => {
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
  for (const expected of ['qr_iban', 'qr_referenz', 'qr_betrag', 'qr_waehrung', 'qr_creditor_name', 'qr_erkannt_am']) {
    assert.ok(columns.includes(expected), `ALTER TABLE should have added ${expected}`);
  }
  migratedDb.close();
  rmSync(dir, { recursive: true, force: true });
});

test('debitor_ibans table exists with a UNIQUE constraint on iban', () => {
  const db = openDatabase(':memory:');
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  assert.ok(names.includes('debitor_ibans'));
  db.close();
});

test('openDatabase rebuilds the freigaben table to widen its rolle CHECK constraint to include iban_abweichung', () => {
  const dir = mkdtempSync(join(tmpdir(), 'db-migration-test-'));
  const dbPath = join(dir, 'legacy.sqlite');
  const legacyDb = new DatabaseSync(dbPath);
  legacyDb.exec(`
    CREATE TABLE personen (churchtools_person_id TEXT PRIMARY KEY, vorname TEXT NOT NULL, nachname TEXT NOT NULL, email TEXT NOT NULL);
    CREATE TABLE jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, eingang_am TEXT NOT NULL, quelle TEXT NOT NULL, absender TEXT, dateiname TEXT NOT NULL, pdf_pfad TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'unzugewiesen');
    CREATE TABLE freigaben (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL REFERENCES jobs(id),
      person_id TEXT NOT NULL REFERENCES personen(churchtools_person_id),
      rolle TEXT NOT NULL CHECK (rolle IN ('freigeber1', 'freigeber2', 'ablehnung', 'freigabe1_eskalation', 'freigabe2_eskalation')),
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
  assert.equal(preserved.rolle, 'freigeber1', 'existing rows must survive the rebuild');
  assert.doesNotThrow(() =>
    migratedDb
      .prepare(
        `INSERT INTO freigaben (job_id, person_id, rolle, zeitpunkt, ip, interessenskonflikt, kommentar, eskaliert_von)
         VALUES (1, '1', 'iban_abweichung', '2026-08-15T09:00:00.000Z', '1.2.3.4', 0, 'QR-IBAN weicht ab', NULL)`
      )
      .run(),
    'the widened CHECK constraint must accept iban_abweichung'
  );
  migratedDb.close();
  rmSync(dir, { recursive: true, force: true });
});

test('openDatabase further widens the freigaben table rolle CHECK to include rechnungsnummer_duplikat, even for a database already migrated to include iban_abweichung', () => {
  const dir = mkdtempSync(join(tmpdir(), 'db-migration-test-'));
  const dbPath = join(dir, 'legacy.sqlite');
  const legacyDb = new DatabaseSync(dbPath);
  legacyDb.exec(`
    CREATE TABLE personen (churchtools_person_id TEXT PRIMARY KEY, vorname TEXT NOT NULL, nachname TEXT NOT NULL, email TEXT NOT NULL);
    CREATE TABLE jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, eingang_am TEXT NOT NULL, quelle TEXT NOT NULL, absender TEXT, dateiname TEXT NOT NULL, pdf_pfad TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'unzugewiesen');
    CREATE TABLE freigaben (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL REFERENCES jobs(id),
      person_id TEXT NOT NULL REFERENCES personen(churchtools_person_id),
      rolle TEXT NOT NULL CHECK (rolle IN ('freigeber1', 'freigeber2', 'ablehnung', 'freigabe1_eskalation', 'freigabe2_eskalation', 'iban_abweichung')),
      zeitpunkt TEXT NOT NULL,
      ip TEXT NOT NULL,
      interessenskonflikt INTEGER NOT NULL DEFAULT 0,
      kommentar TEXT,
      eskaliert_von TEXT REFERENCES personen(churchtools_person_id)
    );
    INSERT INTO personen (churchtools_person_id, vorname, nachname, email) VALUES ('1', 'Frei', 'Geber', 'f@example.org');
    INSERT INTO jobs (eingang_am, quelle, absender, dateiname, pdf_pfad) VALUES ('2026-08-15T08:00:00.000Z', 'scanner', NULL, 'a.pdf', '/tmp/a.pdf');
    INSERT INTO freigaben (job_id, person_id, rolle, zeitpunkt, ip, interessenskonflikt, kommentar, eskaliert_von)
      VALUES (1, '1', 'iban_abweichung', '2026-08-15T09:00:00.000Z', '1.2.3.4', 0, 'QR-IBAN weicht ab', NULL);
  `);
  legacyDb.close();

  const migratedDb = openDatabase(dbPath);
  const preserved = migratedDb.prepare('SELECT * FROM freigaben WHERE id = 1').get();
  assert.equal(preserved.rolle, 'iban_abweichung', 'existing rows must survive the rebuild');
  assert.doesNotThrow(() =>
    migratedDb
      .prepare(
        `INSERT INTO freigaben (job_id, person_id, rolle, zeitpunkt, ip, interessenskonflikt, kommentar, eskaliert_von)
         VALUES (1, '1', 'rechnungsnummer_duplikat', '2026-08-15T09:30:00.000Z', '1.2.3.4', 0, 'Rechnungsnummer bereits erfasst', NULL)`
      )
      .run(),
    'the widened CHECK constraint must accept rechnungsnummer_duplikat'
  );
  migratedDb.close();
  rmSync(dir, { recursive: true, force: true });
});

test('openDatabase rebuilds the mail_log table to widen its typ CHECK constraint to include iban-warnung', () => {
  const dir = mkdtempSync(join(tmpdir(), 'db-migration-test-'));
  const dbPath = join(dir, 'legacy.sqlite');
  const legacyDb = new DatabaseSync(dbPath);
  legacyDb.exec(`
    CREATE TABLE jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, eingang_am TEXT NOT NULL, quelle TEXT NOT NULL, absender TEXT, dateiname TEXT NOT NULL, pdf_pfad TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'unzugewiesen');
    CREATE TABLE mail_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      typ TEXT NOT NULL CHECK (typ IN ('zuweisung', 'reminder', 'eskalation', 'ablehnung', 'sync-fehler')),
      job_id INTEGER REFERENCES jobs(id),
      empfaenger TEXT NOT NULL,
      betreff TEXT NOT NULL,
      text TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('versendet', 'fehlgeschlagen')),
      fehler_details TEXT,
      versucht_am TEXT NOT NULL
    );
    INSERT INTO jobs (eingang_am, quelle, absender, dateiname, pdf_pfad) VALUES ('2026-08-15T08:00:00.000Z', 'scanner', NULL, 'a.pdf', '/tmp/a.pdf');
    INSERT INTO mail_log (typ, job_id, empfaenger, betreff, text, status, versucht_am)
      VALUES ('zuweisung', 1, 'a@example.org', 'Betreff', 'Text', 'versendet', '2026-08-15T08:05:00.000Z');
  `);
  legacyDb.close();

  const migratedDb = openDatabase(dbPath);
  const preserved = migratedDb.prepare('SELECT * FROM mail_log WHERE id = 1').get();
  assert.equal(preserved.empfaenger, 'a@example.org', 'existing rows must survive the rebuild');
  assert.doesNotThrow(() =>
    migratedDb
      .prepare(
        `INSERT INTO mail_log (typ, job_id, empfaenger, betreff, text, status, versucht_am)
         VALUES ('iban-warnung', 1, 'b@example.org', 'Betreff', 'Text', 'versendet', '2026-08-15T09:00:00.000Z')`
      )
      .run(),
    'the widened CHECK constraint must accept iban-warnung'
  );
  migratedDb.close();
  rmSync(dir, { recursive: true, force: true });
});

test('openDatabase further widens the mail_log table typ CHECK to include rechnungsnummer-warnung, even for a database already migrated to include iban-warnung', () => {
  const dir = mkdtempSync(join(tmpdir(), 'db-migration-test-'));
  const dbPath = join(dir, 'legacy.sqlite');
  const legacyDb = new DatabaseSync(dbPath);
  legacyDb.exec(`
    CREATE TABLE jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, eingang_am TEXT NOT NULL, quelle TEXT NOT NULL, absender TEXT, dateiname TEXT NOT NULL, pdf_pfad TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'unzugewiesen');
    CREATE TABLE mail_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      typ TEXT NOT NULL CHECK (typ IN ('zuweisung', 'reminder', 'eskalation', 'ablehnung', 'sync-fehler', 'iban-warnung')),
      job_id INTEGER REFERENCES jobs(id),
      empfaenger TEXT NOT NULL,
      betreff TEXT NOT NULL,
      text TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('versendet', 'fehlgeschlagen')),
      fehler_details TEXT,
      versucht_am TEXT NOT NULL
    );
    INSERT INTO jobs (eingang_am, quelle, absender, dateiname, pdf_pfad) VALUES ('2026-08-15T08:00:00.000Z', 'scanner', NULL, 'a.pdf', '/tmp/a.pdf');
    INSERT INTO mail_log (typ, job_id, empfaenger, betreff, text, status, versucht_am)
      VALUES ('iban-warnung', 1, 'a@example.org', 'Betreff', 'Text', 'versendet', '2026-08-15T08:05:00.000Z');
  `);
  legacyDb.close();

  const migratedDb = openDatabase(dbPath);
  const preserved = migratedDb.prepare('SELECT * FROM mail_log WHERE id = 1').get();
  assert.equal(preserved.empfaenger, 'a@example.org', 'existing rows must survive the rebuild');
  assert.doesNotThrow(() =>
    migratedDb
      .prepare(
        `INSERT INTO mail_log (typ, job_id, empfaenger, betreff, text, status, versucht_am)
         VALUES ('rechnungsnummer-warnung', 1, 'b@example.org', 'Betreff', 'Text', 'versendet', '2026-08-15T09:00:00.000Z')`
      )
      .run(),
    'the widened CHECK constraint must accept rechnungsnummer-warnung'
  );
  migratedDb.close();
  rmSync(dir, { recursive: true, force: true });
});

test('openDatabase does not throw when migrating a mail_log table that contains a row referencing a job_id that no longer exists', () => {
  // node:sqlite's DatabaseSync enforces `PRAGMA foreign_keys` by default. migrateMailLogTable's
  // rebuild does `INSERT INTO mail_log SELECT ... FROM mail_log_pre_iban_warnung_typ` while that
  // FK is live — a real production database can easily have an orphaned mail_log row (e.g. its
  // job was hard-deleted separately), and without disabling the FK check for the duration of the
  // rebuild, that single row aborts the whole migration and takes down app startup.
  const dir = mkdtempSync(join(tmpdir(), 'db-migration-test-'));
  const dbPath = join(dir, 'legacy.sqlite');
  const legacyDb = new DatabaseSync(dbPath);
  legacyDb.exec(`
    CREATE TABLE jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, eingang_am TEXT NOT NULL, quelle TEXT NOT NULL, absender TEXT, dateiname TEXT NOT NULL, pdf_pfad TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'unzugewiesen');
    CREATE TABLE mail_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      typ TEXT NOT NULL CHECK (typ IN ('zuweisung', 'reminder', 'eskalation', 'ablehnung', 'sync-fehler')),
      job_id INTEGER REFERENCES jobs(id),
      empfaenger TEXT NOT NULL,
      betreff TEXT NOT NULL,
      text TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('versendet', 'fehlgeschlagen')),
      fehler_details TEXT,
      versucht_am TEXT NOT NULL
    );
  `);
  // Seeded with FK enforcement off, on purpose: this reproduces how a real orphaned row would
  // actually get there (e.g. the referenced job was later hard-deleted), not a scenario that
  // could only exist if FK enforcement were already broken.
  legacyDb.exec('PRAGMA foreign_keys = OFF');
  legacyDb.exec(`
    INSERT INTO mail_log (typ, job_id, empfaenger, betreff, text, status, versucht_am)
      VALUES ('zuweisung', 999999, 'orphan@example.org', 'Betreff', 'Text', 'versendet', '2026-08-15T08:05:00.000Z');
  `);
  legacyDb.close();

  const migratedDb = openDatabase(dbPath);
  const orphan = migratedDb.prepare('SELECT * FROM mail_log WHERE job_id = 999999').get();
  assert.ok(orphan, 'the orphaned row must survive the migration, not be dropped or block it');
  assert.equal(orphan.empfaenger, 'orphan@example.org');
  migratedDb.close();
  rmSync(dir, { recursive: true, force: true });
});

test('openDatabase rebuilds the cron_log table to widen its job CHECK constraint to include datenbank-sicherung', () => {
  const dir = mkdtempSync(join(tmpdir(), 'db-migration-test-'));
  const dbPath = join(dir, 'legacy.sqlite');
  const legacyDb = new DatabaseSync(dbPath);
  legacyDb.exec(`
    CREATE TABLE cron_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job TEXT NOT NULL CHECK(job IN ('pool-erinnerungen', 'pdf-bereinigung', 'zeitstempel-nachholen')),
      gestartet_am TEXT NOT NULL,
      beendet_am TEXT,
      status TEXT NOT NULL CHECK(status IN ('erfolg', 'fehler', 'laufend')),
      details TEXT
    );
    INSERT INTO cron_log (job, gestartet_am, beendet_am, status, details)
      VALUES ('zeitstempel-nachholen', '2026-08-15T08:00:00.000Z', '2026-08-15T08:00:05.000Z', 'erfolg', 'Nachgeholt: 1');
  `);
  legacyDb.close();

  const migratedDb = openDatabase(dbPath);

  const preserved = migratedDb.prepare('SELECT * FROM cron_log WHERE id = 1').get();
  assert.ok(preserved, 'existing rows must survive the rebuild');
  assert.equal(preserved.job, 'zeitstempel-nachholen');

  assert.doesNotThrow(
    () =>
      migratedDb
        .prepare("INSERT INTO cron_log (job, gestartet_am, beendet_am, status, details) VALUES ('datenbank-sicherung', '2026-08-24T03:00:00.000Z', NULL, 'laufend', NULL)")
        .run(),
    'the widened CHECK constraint must accept datenbank-sicherung'
  );

  migratedDb.close();
  rmSync(dir, { recursive: true, force: true });
});

test('openDatabase rebuilds the person_berechtigungen table to widen its berechtigung CHECK constraint to include audit_log_einsehen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'db-migration-test-'));
  const dbPath = join(dir, 'legacy.sqlite');
  const legacyDb = new DatabaseSync(dbPath);
  legacyDb.exec(`
    CREATE TABLE personen (churchtools_person_id TEXT PRIMARY KEY, vorname TEXT NOT NULL, nachname TEXT NOT NULL, email TEXT NOT NULL);
    CREATE TABLE person_berechtigungen (
      person_id TEXT NOT NULL REFERENCES personen(churchtools_person_id),
      berechtigung TEXT NOT NULL CHECK (berechtigung IN (
        'konten_verwalten', 'debitoren_verwalten', 'geplante_jobs_verwalten',
        'abgelehnt_verwalten', 'mails_einsehen', 'sync_einsehen'
      )),
      PRIMARY KEY (person_id, berechtigung)
    );
    INSERT INTO personen (churchtools_person_id, vorname, nachname, email) VALUES ('1', 'Nur', 'Sync', 'n@example.org');
    INSERT INTO person_berechtigungen (person_id, berechtigung) VALUES ('1', 'sync_einsehen');
  `);
  legacyDb.close();

  const migratedDb = openDatabase(dbPath);
  const preserved = migratedDb.prepare('SELECT * FROM person_berechtigungen WHERE person_id = ?').get('1');
  assert.equal(preserved.berechtigung, 'sync_einsehen', 'existing rows must survive the rebuild');
  assert.doesNotThrow(() =>
    migratedDb.prepare("INSERT INTO person_berechtigungen (person_id, berechtigung) VALUES ('1', 'audit_log_einsehen')").run(),
    'the widened CHECK constraint must accept audit_log_einsehen'
  );
  migratedDb.close();
  rmSync(dir, { recursive: true, force: true });
});

test('openDatabase is a no-op on the person_berechtigungen table when it already has the widened berechtigung CHECK constraint', () => {
  const db = openDatabase(':memory:');
  const before = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'person_berechtigungen'").get().sql;
  const dbAgain = openDatabase(':memory:');
  const after = dbAgain.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'person_berechtigungen'").get().sql;
  assert.equal(before, after);
  db.close();
  dbAgain.close();
});
