// Persistierte Deduplizierung und Versandstatus fuer Sicherheitsalarme
// (services/sicherheitsalarme.js). Ein Alarm gehoert genau zu einem erkannten Zustand
// (alarm_typ + schluessel) und dokumentiert nur den Benachrichtigungsstand. Er ist bewusst
// getrennt vom Auditprotokoll: ein versendeter Alarm klaert keine Loeschabsicht.
export function migrateSicherheitsalarmSchema(db) {
  db.exec('SAVEPOINT sicherheitsalarm_schema');
  try {
    db.exec(`
    CREATE TABLE IF NOT EXISTS sicherheitsalarme (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      alarm_typ TEXT NOT NULL CHECK(alarm_typ IN ('backup_loeschung_offen')),
      schluessel TEXT NOT NULL,
      erkannt_am TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('ausstehend', 'versendet', 'erledigt')) DEFAULT 'ausstehend',
      versuche INTEGER NOT NULL DEFAULT 0,
      naechster_versuch_am TEXT NOT NULL,
      letzter_versuch_am TEXT,
      letzter_fehler TEXT,
      versendet_am TEXT,
      erinnerungen INTEGER NOT NULL DEFAULT 0,
      sperre_token TEXT,
      sperre_bis TEXT,
      erledigt_am TEXT,
      UNIQUE(alarm_typ, schluessel)
    );
    CREATE INDEX IF NOT EXISTS sicherheitsalarme_faellig_idx ON sicherheitsalarme(status, naechster_versuch_am);
    CREATE TRIGGER IF NOT EXISTS sicherheitsalarme_no_delete BEFORE DELETE ON sicherheitsalarme
    BEGIN SELECT RAISE(ABORT, 'Sicherheitsalarme werden nicht geloescht'); END;
    `);
    db.exec('RELEASE sicherheitsalarm_schema');
  } catch (err) {
    db.exec('ROLLBACK TO sicherheitsalarm_schema; RELEASE sicherheitsalarm_schema');
    throw err;
  }
}
