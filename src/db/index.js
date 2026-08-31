import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// `CREATE TABLE IF NOT EXISTS` in schema.sql only reaches a fresh/in-memory database — once any
// database file has already been created once (test data, an early deployment, whatever), that
// statement no-ops on it and new jobs columns silently never arrive. New columns go here too so
// an already-existing database picks them up on next start. Each entry is idempotent: skipped if
// the column already exists (either added by an earlier run of this migration, or present from
// the start via schema.sql on a brand-new database).
const JOBS_TABLE_MIGRATIONS = [
  { column: 'betrag', ddl: 'ALTER TABLE jobs ADD COLUMN betrag TEXT' },
  { column: 'zahlungsziel', ddl: 'ALTER TABLE jobs ADD COLUMN zahlungsziel TEXT' },
  { column: 'rechnungsnummer', ddl: 'ALTER TABLE jobs ADD COLUMN rechnungsnummer TEXT' },
  { column: 'lieferant', ddl: 'ALTER TABLE jobs ADD COLUMN lieferant TEXT' },
  { column: 'debitor_id', ddl: 'ALTER TABLE jobs ADD COLUMN debitor_id INTEGER REFERENCES debitoren(id)' },
  { column: 'aufgesplittet_von', ddl: 'ALTER TABLE jobs ADD COLUMN aufgesplittet_von INTEGER REFERENCES jobs(id)' },
  { column: 'datei_hash', ddl: 'ALTER TABLE jobs ADD COLUMN datei_hash TEXT' },
  { column: 'hinweis_konto_id', ddl: 'ALTER TABLE jobs ADD COLUMN hinweis_konto_id INTEGER REFERENCES konten(id)' },
  { column: 'zeitstempel_gesetzt_am', ddl: 'ALTER TABLE jobs ADD COLUMN zeitstempel_gesetzt_am TEXT' },
  { column: 'zeitstempel_datei_hash', ddl: 'ALTER TABLE jobs ADD COLUMN zeitstempel_datei_hash TEXT' },
  { column: 'abgeschlossen_am', ddl: 'ALTER TABLE jobs ADD COLUMN abgeschlossen_am TEXT' },
  { column: 'qr_iban', ddl: 'ALTER TABLE jobs ADD COLUMN qr_iban TEXT' },
  { column: 'qr_referenz', ddl: 'ALTER TABLE jobs ADD COLUMN qr_referenz TEXT' },
  { column: 'qr_betrag', ddl: 'ALTER TABLE jobs ADD COLUMN qr_betrag TEXT' },
  { column: 'qr_waehrung', ddl: 'ALTER TABLE jobs ADD COLUMN qr_waehrung TEXT' },
  { column: 'qr_creditor_name', ddl: 'ALTER TABLE jobs ADD COLUMN qr_creditor_name TEXT' },
  { column: 'qr_erkannt_am', ddl: 'ALTER TABLE jobs ADD COLUMN qr_erkannt_am TEXT' },
  { column: 'typ', ddl: 'ALTER TABLE jobs ADD COLUMN typ TEXT' },
  { column: 'rechnungsposition', ddl: 'ALTER TABLE jobs ADD COLUMN rechnungsposition TEXT' },
  { column: 'gruppe_pdf_pfad', ddl: 'ALTER TABLE jobs ADD COLUMN gruppe_pdf_pfad TEXT' },
  { column: 'gruppe_zeitstempel_gesetzt_am', ddl: 'ALTER TABLE jobs ADD COLUMN gruppe_zeitstempel_gesetzt_am TEXT' },
  { column: 'gruppe_zeitstempel_datei_hash', ddl: 'ALTER TABLE jobs ADD COLUMN gruppe_zeitstempel_datei_hash TEXT' },
  { column: 'beleg_seitenzahl', ddl: 'ALTER TABLE jobs ADD COLUMN beleg_seitenzahl INTEGER' },
  { column: 'gruppe_abgeholt_am', ddl: 'ALTER TABLE jobs ADD COLUMN gruppe_abgeholt_am TEXT' },
  { column: 'eingereicht_von', ddl: 'ALTER TABLE jobs ADD COLUMN eingereicht_von TEXT REFERENCES personen(churchtools_person_id)' },
  { column: 'auslage_datum', ddl: 'ALTER TABLE jobs ADD COLUMN auslage_datum TEXT' },
  { column: 'beschreibung', ddl: 'ALTER TABLE jobs ADD COLUMN beschreibung TEXT' },
  { column: 'spesenabrechnung_id', ddl: 'ALTER TABLE jobs ADD COLUMN spesenabrechnung_id INTEGER REFERENCES spesenabrechnungen(id)' },
];

// SQLite CHECK constraints can't be widened with ALTER TABLE — same rebuild-in-a-transaction
// approach as migrateFreigabenTable below. The marker this function checks for is `'spesen'`
// (the newest quelle value); check schema.sql's jobs CREATE TABLE for what the CHECK currently
// allows, not this comment.
//
// Must run BEFORE migrateJobsTable(db) in openDatabase(): renaming jobs aside (and later
// dropping the renamed copy) also renames/drops every trigger and index attached to it, since
// SQLite's ALTER TABLE RENAME rewrites their ON-clause to follow the table and DROP TABLE takes
// dependent triggers with it. Running migrateJobsTable(db) immediately afterwards re-creates
// idx_jobs_datei_hash and all four zeitstempel-immutability triggers unconditionally (its own
// CREATE INDEX/TRIGGER IF NOT EXISTS statements), healing what this rebuild just dropped. This
// function deliberately does NOT also add the four new Spesen columns — JOBS_TABLE_MIGRATIONS'
// plain ADD COLUMN entries (which don't care about an unrelated CHECK constraint) already cover
// that, exactly like every other jobs column added since this table's original schema.sql.
function migrateJobsTableQuelleCheck(db) {
  const tableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'jobs'").get();
  if (!tableSql || tableSql.sql.includes("'spesen'")) return;

  // Only run the migration if the old jobs table has the columns it should have from
  // the original schema.sql and JOBS_TABLE_MIGRATIONS. If it doesn't, let migrateJobsTable add
  // them via ALTER TABLE first; a later restart will run this migration on the fully-populated
  // table. We check for konto_id (original schema) and beleg_seitenzahl (latest migration),
  // which covers the full range.
  const cols = new Set(db.prepare('PRAGMA table_info(jobs)').all().map((c) => c.name));
  if (!cols.has('konto_id') || !cols.has('beleg_seitenzahl') || !cols.has('gruppe_abgeholt_am')) {
    console.warn(
      "migrateJobsTableQuelleCheck: jobs table is missing one or more expected columns (konto_id/beleg_seitenzahl/gruppe_abgeholt_am) — skipping the 'spesen' CHECK-widening migration for now. This self-heals on the next restart, once migrateJobsTable(db) has added the missing columns via ALTER TABLE."
    );
    return;
  }

  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec('ALTER TABLE jobs RENAME TO jobs_pre_spesen_quelle');
    db.exec(`
      CREATE TABLE jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        eingang_am TEXT NOT NULL,
        quelle TEXT NOT NULL CHECK (quelle IN ('scanner', 'lieferant', 'spesen')),
        absender TEXT,
        dateiname TEXT NOT NULL,
        pdf_pfad TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN (
          'unzugewiesen','zugewiesen','kontiert','freigabe1','freigabe2',
          'abgeschlossen','abgeholt','archiviert','abgelehnt','aufgesplittet','geloescht'
        )) DEFAULT 'unzugewiesen',
        konto_id INTEGER REFERENCES konten(id),
        zugewiesen_an TEXT REFERENCES personen(churchtools_person_id),
        abgelehnt_von TEXT REFERENCES personen(churchtools_person_id),
        ablehnungsgrund TEXT,
        fetched_by_n8n_at TEXT,
        thumbnail_pfad TEXT,
        freigabe1_eskaliert_von TEXT REFERENCES personen(churchtools_person_id),
        freigabe1_eskalationsgrund TEXT,
        freigabe2_eskaliert_von TEXT REFERENCES personen(churchtools_person_id),
        freigabe2_eskalationsgrund TEXT,
        reminder_gesendet_at TEXT,
        eskalation_gesendet_at TEXT,
        archiviert_am TEXT,
        freigabe1_eskaliert_an_admin INTEGER NOT NULL DEFAULT 0,
        freigabe2_eskaliert_an_admin INTEGER NOT NULL DEFAULT 0,
        betrag TEXT,
        zahlungsziel TEXT,
        rechnungsnummer TEXT,
        lieferant TEXT,
        debitor_id INTEGER REFERENCES debitoren(id),
        aufgesplittet_von INTEGER REFERENCES jobs(id),
        datei_hash TEXT,
        hinweis_konto_id INTEGER REFERENCES konten(id),
        zeitstempel_gesetzt_am TEXT,
        zeitstempel_datei_hash TEXT,
        abgeschlossen_am TEXT,
        qr_iban TEXT,
        qr_referenz TEXT,
        qr_betrag TEXT,
        qr_waehrung TEXT,
        qr_creditor_name TEXT,
        qr_erkannt_am TEXT,
        typ TEXT,
        rechnungsposition TEXT,
        gruppe_pdf_pfad TEXT,
        gruppe_zeitstempel_gesetzt_am TEXT,
        gruppe_zeitstempel_datei_hash TEXT,
        beleg_seitenzahl INTEGER,
        gruppe_abgeholt_am TEXT
      )
    `);
    db.exec(`
      INSERT INTO jobs (
        id, eingang_am, quelle, absender, dateiname, pdf_pfad, status, konto_id, zugewiesen_an,
        abgelehnt_von, ablehnungsgrund, fetched_by_n8n_at, thumbnail_pfad, freigabe1_eskaliert_von,
        freigabe1_eskalationsgrund, freigabe2_eskaliert_von, freigabe2_eskalationsgrund,
        reminder_gesendet_at, eskalation_gesendet_at, archiviert_am, freigabe1_eskaliert_an_admin,
        freigabe2_eskaliert_an_admin, betrag, zahlungsziel, rechnungsnummer, lieferant, debitor_id,
        aufgesplittet_von, datei_hash, hinweis_konto_id, zeitstempel_gesetzt_am,
        zeitstempel_datei_hash, abgeschlossen_am, qr_iban, qr_referenz, qr_betrag, qr_waehrung,
        qr_creditor_name, qr_erkannt_am, typ, rechnungsposition, gruppe_pdf_pfad,
        gruppe_zeitstempel_gesetzt_am, gruppe_zeitstempel_datei_hash, beleg_seitenzahl, gruppe_abgeholt_am
      )
      SELECT
        id, eingang_am, quelle, absender, dateiname, pdf_pfad, status, konto_id, zugewiesen_an,
        abgelehnt_von, ablehnungsgrund, fetched_by_n8n_at, thumbnail_pfad, freigabe1_eskaliert_von,
        freigabe1_eskalationsgrund, freigabe2_eskaliert_von, freigabe2_eskalationsgrund,
        reminder_gesendet_at, eskalation_gesendet_at, archiviert_am, freigabe1_eskaliert_an_admin,
        freigabe2_eskaliert_an_admin, betrag, zahlungsziel, rechnungsnummer, lieferant, debitor_id,
        aufgesplittet_von, datei_hash, hinweis_konto_id, zeitstempel_gesetzt_am,
        zeitstempel_datei_hash, abgeschlossen_am, qr_iban, qr_referenz, qr_betrag, qr_waehrung,
        qr_creditor_name, qr_erkannt_am, typ, rechnungsposition, gruppe_pdf_pfad,
        gruppe_zeitstempel_gesetzt_am, gruppe_zeitstempel_datei_hash, beleg_seitenzahl, gruppe_abgeholt_am
      FROM jobs_pre_spesen_quelle
    `);
    db.exec('DROP TABLE jobs_pre_spesen_quelle');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

function migrateJobsTable(db) {
  const existing = new Set(db.prepare('PRAGMA table_info(jobs)').all().map((col) => col.name));
  for (const { column, ddl } of JOBS_TABLE_MIGRATIONS) {
    if (!existing.has(column)) {
      db.exec(ddl);
    }
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_jobs_datei_hash ON jobs(datei_hash)');

  // Manipulationsschutz für bereits bestehende Datenbanken — siehe schema.sql für die
  // ausführliche Begründung. Beide Trigger sind CREATE TRIGGER IF NOT EXISTS, also idempotent wie
  // der Rest dieser Funktion.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_zeitstempel_hash_unveraenderlich
    BEFORE UPDATE OF zeitstempel_datei_hash ON jobs
    WHEN OLD.zeitstempel_datei_hash IS NOT NULL
      AND NEW.zeitstempel_datei_hash IS NOT NULL
      AND NEW.zeitstempel_datei_hash <> OLD.zeitstempel_datei_hash
    BEGIN
      SELECT RAISE(ABORT, 'zeitstempel_datei_hash ist unveraenderlich, sobald gesetzt');
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_zeitstempel_gesetzt_am_unveraenderlich
    BEFORE UPDATE OF zeitstempel_gesetzt_am ON jobs
    WHEN OLD.zeitstempel_gesetzt_am IS NOT NULL
      AND NEW.zeitstempel_gesetzt_am IS NOT NULL
      AND NEW.zeitstempel_gesetzt_am <> OLD.zeitstempel_gesetzt_am
    BEGIN
      SELECT RAISE(ABORT, 'zeitstempel_gesetzt_am ist unveraenderlich, sobald gesetzt');
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_gruppe_zeitstempel_hash_unveraenderlich
    BEFORE UPDATE OF gruppe_zeitstempel_datei_hash ON jobs
    WHEN OLD.gruppe_zeitstempel_datei_hash IS NOT NULL
      AND NEW.gruppe_zeitstempel_datei_hash IS NOT NULL
      AND NEW.gruppe_zeitstempel_datei_hash <> OLD.gruppe_zeitstempel_datei_hash
    BEGIN
      SELECT RAISE(ABORT, 'gruppe_zeitstempel_datei_hash ist unveraenderlich, sobald gesetzt');
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_gruppe_zeitstempel_gesetzt_am_unveraenderlich
    BEFORE UPDATE OF gruppe_zeitstempel_gesetzt_am ON jobs
    WHEN OLD.gruppe_zeitstempel_gesetzt_am IS NOT NULL
      AND NEW.gruppe_zeitstempel_gesetzt_am IS NOT NULL
      AND NEW.gruppe_zeitstempel_gesetzt_am <> OLD.gruppe_zeitstempel_gesetzt_am
    BEGIN
      SELECT RAISE(ABORT, 'gruppe_zeitstempel_gesetzt_am ist unveraenderlich, sobald gesetzt');
    END
  `);

  // Runs strictly after the loop above, so the abgeschlossen_am column is guaranteed to exist by
  // now (whether it came from schema.sql on a fresh database or from the ALTER TABLE entry).
  //
  // Backfill: on the day the RFC3161 feature is deployed to a database that already has
  // 'abgeschlossen' jobs, those jobs have no abgeschlossen_am (the column is new). Without this,
  // they are caught by the n8n pickup gate (jobsRepo.listAbholbereitJobs/confirmAbholung block
  // every abgeschlossen job without a timestamp) while being invisible to the admin warning
  // banner (countZeitstempelUeberfaellig skips abgeschlossen_am IS NULL) — un-pickupable with
  // nothing on the dashboard saying why. Stamping them with "now" puts them on the same clock as
  // freshly completed jobs: the nachhol-job picks them up, and if the TSA stays unreachable the
  // banner does start warning about them once the threshold passes.
  //
  // Idempotent by construction, no guard flag needed: it only touches rows whose abgeschlossen_am
  // is still NULL, and every row it touches gets a non-NULL value, so a second run matches nothing.
  db.prepare("UPDATE jobs SET abgeschlossen_am = ? WHERE status = 'abgeschlossen' AND abgeschlossen_am IS NULL").run(
    new Date().toISOString()
  );
}

// SQLite CHECK constraints can't be widened with ALTER TABLE — unlike JOBS_TABLE_MIGRATIONS'
// simple ADD COLUMN entries, an already-existing freigaben table (any database whose rolle CHECK
// predates the current marker value checked for below) keeps its original, narrower CHECK
// forever, since `CREATE TABLE IF NOT EXISTS` in schema.sql no-ops on it. The only way to widen a
// CHECK constraint in SQLite is to rebuild the table: rename it aside, create a fresh one from the
// current schema, copy every row across, then drop the old one — all inside one transaction so a
// crash mid-migration can't leave the database without a freigaben table at all. The marker value
// this function checks for (currently 'iban_abweichung') moves forward each time the CHECK is
// widened again — it's just "the newest rolle value", not tied to any one feature; check the
// CREATE TABLE below for what the CHECK currently allows, not this comment.
function migrateFreigabenTable(db) {
  const tableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'freigaben'").get();
  if (!tableSql || tableSql.sql.includes('iban_abweichung')) return;

  // node:sqlite enforces `PRAGMA foreign_keys` by default, and it must be toggled OFF outside any
  // transaction (the pragma is a documented no-op if set from inside one). Without this, a single
  // freigaben row referencing a jobs.id or personen.churchtools_person_id that no longer exists
  // aborts the INSERT below, the catch rolls back, and the error propagates out of openDatabase —
  // the whole app fails to start. Restoring it in `finally` (not just after COMMIT) matters: a
  // migration that throws must not leave FK enforcement permanently disabled.
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec('ALTER TABLE freigaben RENAME TO freigaben_pre_iban_abweichung_rolle');
    db.exec(`
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
      )
    `);
    db.exec(`
      INSERT INTO freigaben (id, job_id, person_id, rolle, zeitpunkt, ip, interessenskonflikt, kommentar, eskaliert_von)
      SELECT id, job_id, person_id, rolle, zeitpunkt, ip, interessenskonflikt, kommentar, eskaliert_von FROM freigaben_pre_iban_abweichung_rolle
    `);
    db.exec('DROP TABLE freigaben_pre_iban_abweichung_rolle');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

// Same rationale as migrateFreigabenTable above: mail_log.typ's CHECK constraint can't be
// widened with ALTER TABLE, so an already-running database that predates 'iban-warnung' needs
// its mail_log table rebuilt in place to accept the new value.
function migrateMailLogTable(db) {
  const tableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'mail_log'").get();
  if (!tableSql || tableSql.sql.includes('iban-warnung')) return;

  // See the matching comment in migrateFreigabenTable above: node:sqlite enforces
  // `PRAGMA foreign_keys` by default, so a single mail_log row referencing a jobs.id that no
  // longer exists would otherwise abort this INSERT and take down app startup entirely.
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec('ALTER TABLE mail_log RENAME TO mail_log_pre_iban_warnung_typ');
    db.exec(`
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
      )
    `);
    db.exec(`
      INSERT INTO mail_log (id, typ, job_id, empfaenger, betreff, text, status, fehler_details, versucht_am)
      SELECT id, typ, job_id, empfaenger, betreff, text, status, fehler_details, versucht_am FROM mail_log_pre_iban_warnung_typ
    `);
    db.exec('DROP TABLE mail_log_pre_iban_warnung_typ');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

// Same rationale as migrateFreigabenTable above: an already-existing cron_log table (any database
// that predates the 'datenbank-sicherung' job name) keeps its original, narrower schema forever
// otherwise, and startCronLauf('datenbank-sicherung', ...) would fail on it. The marker value this
// function checks for moves forward each time the CHECK is widened again -- check the CREATE TABLE
// below for what it currently allows, not this comment.
function migrateCronLogTable(db) {
  const tableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'cron_log'").get();
  if (!tableSql || tableSql.sql.includes('datenbank-sicherung')) return;

  db.exec('BEGIN');
  try {
    db.exec('ALTER TABLE cron_log RENAME TO cron_log_pre_datenbank_sicherung');
    db.exec(`
      CREATE TABLE cron_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job TEXT NOT NULL CHECK(job IN ('pool-erinnerungen', 'pdf-bereinigung', 'zeitstempel-nachholen', 'datenbank-sicherung')),
        gestartet_am TEXT NOT NULL,
        beendet_am TEXT,
        status TEXT NOT NULL CHECK(status IN ('erfolg', 'fehler', 'laufend')),
        details TEXT
      )
    `);
    db.exec(`
      INSERT INTO cron_log (id, job, gestartet_am, beendet_am, status, details)
      SELECT id, job, gestartet_am, beendet_am, status, details FROM cron_log_pre_datenbank_sicherung
    `);
    db.exec('DROP TABLE cron_log_pre_datenbank_sicherung');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// Same rationale as migrateFreigabenTable above: an already-existing person_berechtigungen table
// (any database whose berechtigung CHECK predates 'audit_log_einsehen') keeps its original,
// narrower CHECK forever otherwise, since `CREATE TABLE IF NOT EXISTS` in schema.sql no-ops on it.
function migratePersonBerechtigungenTable(db) {
  const tableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'person_berechtigungen'").get();
  if (!tableSql || tableSql.sql.includes('audit_log_einsehen')) return;

  // See the matching comment in migrateFreigabenTable above: node:sqlite enforces
  // `PRAGMA foreign_keys` by default, so a single person_berechtigungen row referencing a
  // personen.churchtools_person_id that no longer exists would otherwise abort this INSERT.
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec('ALTER TABLE person_berechtigungen RENAME TO person_berechtigungen_pre_audit_log_einsehen');
    db.exec(`
      CREATE TABLE person_berechtigungen (
        person_id TEXT NOT NULL REFERENCES personen(churchtools_person_id),
        berechtigung TEXT NOT NULL CHECK (berechtigung IN (
          'konten_verwalten', 'debitoren_verwalten', 'geplante_jobs_verwalten',
          'abgelehnt_verwalten', 'mails_einsehen', 'sync_einsehen', 'audit_log_einsehen'
        )),
        PRIMARY KEY (person_id, berechtigung)
      )
    `);
    db.exec(`
      INSERT INTO person_berechtigungen (person_id, berechtigung)
      SELECT person_id, berechtigung FROM person_berechtigungen_pre_audit_log_einsehen
    `);
    db.exec('DROP TABLE person_berechtigungen_pre_audit_log_einsehen');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

// Same rationale/pattern as migrateCronLogTable above, one more CHECK widening for the new
// 'split-gruppen-nachholen' cron job. Marker value moves forward again the next time this CHECK
// needs widening -- check the CREATE TABLE below for what it currently allows, not this comment.
function migrateCronLogTableSplitGruppen(db) {
  const tableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'cron_log'").get();
  if (!tableSql || tableSql.sql.includes('split-gruppen-nachholen')) return;

  db.exec('BEGIN');
  try {
    db.exec('ALTER TABLE cron_log RENAME TO cron_log_pre_split_gruppen_nachholen');
    db.exec(`
      CREATE TABLE cron_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job TEXT NOT NULL CHECK(job IN ('pool-erinnerungen', 'pdf-bereinigung', 'zeitstempel-nachholen', 'datenbank-sicherung', 'split-gruppen-nachholen')),
        gestartet_am TEXT NOT NULL,
        beendet_am TEXT,
        status TEXT NOT NULL CHECK(status IN ('erfolg', 'fehler', 'laufend')),
        details TEXT
      )
    `);
    db.exec(`
      INSERT INTO cron_log (id, job, gestartet_am, beendet_am, status, details)
      SELECT id, job, gestartet_am, beendet_am, status, details FROM cron_log_pre_split_gruppen_nachholen
    `);
    db.exec('DROP TABLE cron_log_pre_split_gruppen_nachholen');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function openDatabase(dbPath) {
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
  migrateJobsTableQuelleCheck(db);
  migrateJobsTable(db);
  migrateFreigabenTable(db);
  migrateMailLogTable(db);
  migrateCronLogTable(db);
  migratePersonBerechtigungenTable(db);
  migrateCronLogTableSplitGruppen(db);
  return db;
}
