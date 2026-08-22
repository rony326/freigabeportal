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
];

function migrateJobsTable(db) {
  const existing = new Set(db.prepare('PRAGMA table_info(jobs)').all().map((col) => col.name));
  for (const { column, ddl } of JOBS_TABLE_MIGRATIONS) {
    if (!existing.has(column)) {
      db.exec(ddl);
    }
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_jobs_datei_hash ON jobs(datei_hash)');
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

export function openDatabase(dbPath) {
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
  migrateJobsTable(db);
  migrateFreigabenTable(db);
  return db;
}
