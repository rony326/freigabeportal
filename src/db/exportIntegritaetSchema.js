// Paket "Export- und Zahlungsintegritaet": unveraenderlicher Gruppen-Freigabe-Snapshot und
// append-only Entscheidungen zu Altfaellen ohne belastbaren Snapshot. Laeuft vor
// migrateSecuritySchema, damit dessen Audit-Trigger die neue jobs-Spalte bereits mitprotokollieren.
export function migrateExportIntegritaetSchema(db) {
  const jobColumns = new Set(db.prepare('PRAGMA table_info(jobs)').all().map((c) => c.name));
  if (!jobColumns.has('gruppe_freigabe_snapshot')) db.exec('ALTER TABLE jobs ADD COLUMN gruppe_freigabe_snapshot TEXT');
  db.exec(`DROP TRIGGER IF EXISTS trg_gruppe_freigabe_snapshot_unveraenderlich;
    CREATE TRIGGER trg_gruppe_freigabe_snapshot_unveraenderlich BEFORE UPDATE OF gruppe_freigabe_snapshot ON jobs
    WHEN OLD.gruppe_freigabe_snapshot IS NOT NULL AND NEW.gruppe_freigabe_snapshot IS NOT OLD.gruppe_freigabe_snapshot
    BEGIN SELECT RAISE(ABORT, 'gruppe_freigabe_snapshot ist unveraenderlich, sobald gesetzt'); END;`);

  // Eine Entscheidung pro Beleg bzw. Splitgruppe (Elternjob). angezeigte_daten enthaelt genau den
  // Stand, der der entscheidenden Person gezeigt wurde, inklusive Herkunft jedes Werts.
  db.exec(`CREATE TABLE IF NOT EXISTS altfall_entscheidungen (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL UNIQUE REFERENCES jobs(id),
    entscheidung TEXT NOT NULL CHECK (entscheidung IN ('nachbestaetigt', 'nur_archiv')),
    angezeigte_daten TEXT NOT NULL,
    stand TEXT NOT NULL,
    person_id TEXT NOT NULL REFERENCES personen(churchtools_person_id),
    person_name TEXT NOT NULL,
    begruendung TEXT NOT NULL CHECK (length(trim(begruendung)) > 0),
    zeitpunkt TEXT NOT NULL
  );
  CREATE TRIGGER IF NOT EXISTS altfall_entscheidungen_no_update BEFORE UPDATE ON altfall_entscheidungen
  BEGIN SELECT RAISE(ABORT, 'altfall_entscheidungen ist unveraenderlich'); END;
  CREATE TRIGGER IF NOT EXISTS altfall_entscheidungen_no_delete BEFORE DELETE ON altfall_entscheidungen
  BEGIN SELECT RAISE(ABORT, 'altfall_entscheidungen ist unveraenderlich'); END;`);
}
