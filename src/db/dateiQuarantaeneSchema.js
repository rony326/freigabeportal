// Quarantaene fuer verwaiste finale Dokumente (services/verwaisteDateien.js). Eine Zeile entsteht
// beim Verschieben in dieselbe Transaktion wie das Audit-Ereignis. Danach ist nur noch genau ein
// Statuswechsel aus 'quarantaene' heraus erlaubt; Loeschen der Zeile ist gesperrt.
export function migrateDateiQuarantaeneSchema(db) {
  db.exec('SAVEPOINT datei_quarantaene_schema');
  try {
    db.exec(`
    CREATE TABLE IF NOT EXISTS datei_quarantaene (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dateiname TEXT NOT NULL,
      sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
      groesse INTEGER NOT NULL,
      datei_geaendert_am TEXT NOT NULL,
      verschoben_am TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('quarantaene', 'wiederhergestellt', 'geloescht')) DEFAULT 'quarantaene',
      entschieden_von TEXT,
      entschieden_am TEXT,
      begruendung TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS datei_quarantaene_offen_idx ON datei_quarantaene(dateiname) WHERE status = 'quarantaene';
    CREATE TRIGGER IF NOT EXISTS datei_quarantaene_no_delete BEFORE DELETE ON datei_quarantaene
    BEGIN SELECT RAISE(ABORT, 'Quarantaene-Nachweise sind unveraenderlich'); END;
    CREATE TRIGGER IF NOT EXISTS datei_quarantaene_nur_entscheidung BEFORE UPDATE ON datei_quarantaene
    WHEN OLD.status <> 'quarantaene' OR NEW.status NOT IN ('wiederhergestellt', 'geloescht')
      OR NEW.id IS NOT OLD.id OR NEW.dateiname IS NOT OLD.dateiname OR NEW.sha256 IS NOT OLD.sha256
      OR NEW.groesse IS NOT OLD.groesse OR NEW.datei_geaendert_am IS NOT OLD.datei_geaendert_am
      OR NEW.verschoben_am IS NOT OLD.verschoben_am
      OR NEW.entschieden_von IS NULL OR NEW.entschieden_am IS NULL OR NEW.begruendung IS NULL
    BEGIN SELECT RAISE(ABORT, 'Quarantaene-Nachweise sind unveraenderlich'); END;
    `);
    db.exec('RELEASE datei_quarantaene_schema');
  } catch (err) {
    db.exec('ROLLBACK TO datei_quarantaene_schema; RELEASE datei_quarantaene_schema');
    throw err;
  }
}
