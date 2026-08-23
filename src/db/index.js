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
  { column: 'abgeschlossen_am', ddl: 'ALTER TABLE jobs ADD COLUMN abgeschlossen_am TEXT' },
];

function migrateJobsTable(db) {
  const existing = new Set(db.prepare('PRAGMA table_info(jobs)').all().map((col) => col.name));
  for (const { column, ddl } of JOBS_TABLE_MIGRATIONS) {
    if (!existing.has(column)) {
      db.exec(ddl);
    }
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_jobs_datei_hash ON jobs(datei_hash)');

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
// simple ADD COLUMN entries, an already-existing freigaben table (any database that predates the
// 'freigabe1_eskalation'/'freigabe2_eskalation' rolle values) keeps its original, narrower CHECK
// forever, since `CREATE TABLE IF NOT EXISTS` in schema.sql no-ops on it. The only way to widen a
// CHECK constraint in SQLite is to rebuild the table: rename it aside, create a fresh one from the
// current schema, copy every row across, then drop the old one — all inside one transaction so a
// crash mid-migration can't leave the database without a freigaben table at all.
function migrateFreigabenTable(db) {
  const tableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'freigaben'").get();
  if (!tableSql || tableSql.sql.includes('freigabe1_eskalation')) return;

  db.exec('BEGIN');
  try {
    db.exec('ALTER TABLE freigaben RENAME TO freigaben_pre_eskalation_rolle');
    db.exec(`
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
      )
    `);
    db.exec(`
      INSERT INTO freigaben (id, job_id, person_id, rolle, zeitpunkt, ip, interessenskonflikt, kommentar, eskaliert_von)
      SELECT id, job_id, person_id, rolle, zeitpunkt, ip, interessenskonflikt, kommentar, eskaliert_von FROM freigaben_pre_eskalation_rolle
    `);
    db.exec('DROP TABLE freigaben_pre_eskalation_rolle');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// Same rationale as migrateFreigabenTable above: an already-existing cron_log table (any database
// that predates the 'zeitstempel-nachholen' job name, or predates the 'laufend' status value and
// nullable beendet_am that a running-but-not-yet-finished zeitstempel-nachholen entry needs — see
// hasRecentRunningCronLauf in cronLogRepo.js) keeps its original, narrower schema forever
// otherwise, and logCronLauf/startCronLauf('zeitstempel-nachholen', ...) would fail on it.
function migrateCronLogTable(db) {
  const tableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'cron_log'").get();
  if (!tableSql || (tableSql.sql.includes('zeitstempel-nachholen') && tableSql.sql.includes("'laufend'"))) return;

  db.exec('BEGIN');
  try {
    db.exec('ALTER TABLE cron_log RENAME TO cron_log_pre_zeitstempel_nachholen');
    db.exec(`
      CREATE TABLE cron_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job TEXT NOT NULL CHECK(job IN ('pool-erinnerungen', 'pdf-bereinigung', 'zeitstempel-nachholen')),
        gestartet_am TEXT NOT NULL,
        beendet_am TEXT,
        status TEXT NOT NULL CHECK(status IN ('erfolg', 'fehler', 'laufend')),
        details TEXT
      )
    `);
    db.exec(`
      INSERT INTO cron_log (id, job, gestartet_am, beendet_am, status, details)
      SELECT id, job, gestartet_am, beendet_am, status, details FROM cron_log_pre_zeitstempel_nachholen
    `);
    db.exec('DROP TABLE cron_log_pre_zeitstempel_nachholen');
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
  migrateJobsTable(db);
  migrateFreigabenTable(db);
  migrateCronLogTable(db);
  return db;
}
