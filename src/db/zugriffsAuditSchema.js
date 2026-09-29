// Drosselzaehler fuer protokollierte Zugriffsverweigerungen (services/zugriffsAudit.js).
// Die ersten Verweigerungen je Fenster und Schluessel stehen als unveraenderliche Ereignisse in
// audit_ereignisse; diese Tabelle zaehlt nur das darueber hinausgehende Volumen. Die Zaehler sind
// bewusst veraenderbar (Inkrement) und deshalb kein Manipulationsnachweis.
export function migrateZugriffsAuditSchema(db) {
  db.exec('SAVEPOINT zugriffs_audit_schema');
  try {
    db.exec(`
    CREATE TABLE IF NOT EXISTS audit_zugriff_drosselung (
      fenster_start TEXT NOT NULL,
      schluessel TEXT NOT NULL CHECK(length(schluessel) <= 200),
      anzahl INTEGER NOT NULL DEFAULT 0,
      protokolliert INTEGER NOT NULL DEFAULT 0,
      drosselung_gemeldet INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (fenster_start, schluessel)
    );
    CREATE INDEX IF NOT EXISTS audit_zugriff_objekt_idx ON audit_ereignisse(objekt, aktion, zeitpunkt);
    `);
    db.exec('RELEASE zugriffs_audit_schema');
  } catch (err) {
    db.exec('ROLLBACK TO zugriffs_audit_schema; RELEASE zugriffs_audit_schema');
    throw err;
  }
}
