// Lokales Register erzeugter Audit-Exportpakete (services/auditExport.js). Es dient als Cursor
// (letzte exportierte Ereignis-ID) und Kettenanker (Hash des Vorgaengerpakets). Das Register liegt
// in derselben Datenbank wie das Auditprotokoll und ist daher selbst KEIN Nachweis externer
// Unveraenderlichkeit; es ermoeglicht nur, Pakete lueckenlos zu erzeugen und spaeter gegen extern
// aufbewahrte Hashes abzugleichen.
export function migrateAuditExportSchema(db) {
  db.exec('SAVEPOINT audit_export_schema');
  try {
    db.exec(`
    CREATE TABLE IF NOT EXISTS audit_export_pakete (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      von_id INTEGER NOT NULL,
      bis_id INTEGER NOT NULL CHECK(bis_id >= von_id),
      anzahl INTEGER NOT NULL CHECK(anzahl > 0),
      luecken TEXT NOT NULL,
      inhalt_sha256 TEXT NOT NULL CHECK(length(inhalt_sha256) = 64),
      vorgaenger_sha256 TEXT,
      paket_sha256 TEXT NOT NULL UNIQUE CHECK(length(paket_sha256) = 64),
      erstellt_am TEXT NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS audit_export_pakete_no_update BEFORE UPDATE ON audit_export_pakete
    BEGIN SELECT RAISE(ABORT, 'audit_export_pakete ist unveraenderlich'); END;
    CREATE TRIGGER IF NOT EXISTS audit_export_pakete_no_delete BEFORE DELETE ON audit_export_pakete
    BEGIN SELECT RAISE(ABORT, 'audit_export_pakete ist unveraenderlich'); END;
    `);
    db.exec('RELEASE audit_export_schema');
  } catch (err) {
    db.exec('ROLLBACK TO audit_export_schema; RELEASE audit_export_schema');
    throw err;
  }
}
