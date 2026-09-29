export function migrateAuditRequestSchema(db) {
  db.exec('SAVEPOINT audit_request_schema');
  try {
    db.exec(`
    CREATE TABLE IF NOT EXISTS audit_request_zuordnung (
      ereignis_id INTEGER PRIMARY KEY REFERENCES audit_ereignisse(id),
      request_id TEXT NOT NULL CHECK(length(request_id) = 36)
    );
    CREATE INDEX IF NOT EXISTS audit_request_id_idx ON audit_request_zuordnung(request_id, ereignis_id);
    CREATE TRIGGER IF NOT EXISTS audit_request_no_update BEFORE UPDATE ON audit_request_zuordnung
    BEGIN SELECT RAISE(ABORT, 'Audit-Request-Zuordnungen sind unveraenderlich'); END;
    CREATE TRIGGER IF NOT EXISTS audit_request_no_delete BEFORE DELETE ON audit_request_zuordnung
    BEGIN SELECT RAISE(ABORT, 'Audit-Request-Zuordnungen sind unveraenderlich'); END;
    CREATE TRIGGER IF NOT EXISTS audit_request_capture AFTER INSERT ON audit_ereignisse
    WHEN audit_request_id() IS NOT NULL
    BEGIN INSERT INTO audit_request_zuordnung (ereignis_id, request_id) VALUES (NEW.id, audit_request_id()); END;
    CREATE TABLE IF NOT EXISTS audit_lauf_zuordnung (
      ereignis_id INTEGER PRIMARY KEY REFERENCES audit_ereignisse(id),
      lauf_id TEXT NOT NULL CHECK(length(lauf_id) = 36),
      lauf_typ TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS audit_lauf_id_idx ON audit_lauf_zuordnung(lauf_id, ereignis_id);
    CREATE TRIGGER IF NOT EXISTS audit_lauf_no_update BEFORE UPDATE ON audit_lauf_zuordnung
    BEGIN SELECT RAISE(ABORT, 'Audit-Lauf-Zuordnungen sind unveraenderlich'); END;
    CREATE TRIGGER IF NOT EXISTS audit_lauf_no_delete BEFORE DELETE ON audit_lauf_zuordnung
    BEGIN SELECT RAISE(ABORT, 'Audit-Lauf-Zuordnungen sind unveraenderlich'); END;
    CREATE TRIGGER IF NOT EXISTS audit_lauf_capture AFTER INSERT ON audit_ereignisse
    WHEN audit_operation_id() IS NOT NULL
    BEGIN INSERT INTO audit_lauf_zuordnung (ereignis_id, lauf_id, lauf_typ)
      VALUES (NEW.id, audit_operation_id(), audit_operation_kind()); END;
    CREATE INDEX IF NOT EXISTS audit_backup_operation_idx ON audit_ereignisse (
      objekt, aktion, objekt_id, json_extract(CASE WHEN json_valid(nachher) THEN nachher ELSE '{}' END, '$.operationId')
    );
    CREATE INDEX IF NOT EXISTS audit_backup_review_idx ON audit_ereignisse (
      objekt, aktion, objekt_id, json_extract(CASE WHEN json_valid(nachher) THEN nachher ELSE '{}' END, '$.intentId')
    );
    `);
    db.exec('RELEASE audit_request_schema');
  } catch (err) {
    db.exec('ROLLBACK TO audit_request_schema; RELEASE audit_request_schema');
    throw err;
  }
}
