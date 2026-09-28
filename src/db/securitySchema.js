const RIGHTS = [
  'konten_verwalten', 'debitoren_verwalten', 'geplante_jobs_verwalten',
  'abgelehnt_verwalten', 'mails_einsehen', 'sync_einsehen', 'audit_log_einsehen',
  'pool_zuweisen', 'sync_verwalten', 'workflow_eingreifen',
];

export function migrateSecuritySchema(db) {
  const jobColumns = new Set(db.prepare('PRAGMA table_info(jobs)').all().map((c) => c.name));
  for (const [column, type] of Object.entries({ freigabe_snapshot: 'TEXT', final_datei_hash: 'TEXT', zeitstempel_erforderlich: 'INTEGER NOT NULL DEFAULT 0' })) {
    if (!jobColumns.has(column)) db.exec(`ALTER TABLE jobs ADD COLUMN ${column} ${type}`);
  }
  for (const [trigger, column] of Object.entries({
    trg_zeitstempel_hash_unveraenderlich: 'zeitstempel_datei_hash',
    trg_zeitstempel_gesetzt_am_unveraenderlich: 'zeitstempel_gesetzt_am',
    trg_gruppe_zeitstempel_hash_unveraenderlich: 'gruppe_zeitstempel_datei_hash',
    trg_gruppe_zeitstempel_gesetzt_am_unveraenderlich: 'gruppe_zeitstempel_gesetzt_am',
    trg_freigabe_snapshot_unveraenderlich: 'freigabe_snapshot',
  })) {
    db.exec(`DROP TRIGGER IF EXISTS ${trigger};
      CREATE TRIGGER ${trigger} BEFORE UPDATE OF ${column} ON jobs
      WHEN OLD.${column} IS NOT NULL AND NEW.${column} IS NOT OLD.${column}
      BEGIN SELECT RAISE(ABORT, '${column} ist unveraenderlich, sobald gesetzt'); END;`);
  }
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'person_berechtigungen'").get().sql;
  if (!sql.includes('workflow_eingreifen')) {
    db.exec(`BEGIN;
      CREATE TABLE person_berechtigungen_security (
        person_id TEXT NOT NULL REFERENCES personen(churchtools_person_id),
        berechtigung TEXT NOT NULL CHECK (berechtigung IN (${RIGHTS.map((r) => `'${r}'`).join(',')})),
        PRIMARY KEY (person_id, berechtigung)
      );
      INSERT INTO person_berechtigungen_security SELECT * FROM person_berechtigungen;
      DROP TABLE person_berechtigungen;
      ALTER TABLE person_berechtigungen_security RENAME TO person_berechtigungen;
      COMMIT;`);
  }
  db.exec(`CREATE TABLE IF NOT EXISTS audit_ereignisse (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    zeitpunkt TEXT NOT NULL,
    person_id TEXT NOT NULL,
    person_name TEXT NOT NULL,
    objekt TEXT NOT NULL,
    objekt_id TEXT NOT NULL,
    aktion TEXT NOT NULL,
    vorher TEXT,
    nachher TEXT,
    begruendung TEXT
  );
  CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_ereignisse
  BEGIN SELECT RAISE(ABORT, 'Audit-Ereignisse sind unveraenderlich'); END;
  CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_ereignisse
  BEGIN SELECT RAISE(ABORT, 'Audit-Ereignisse sind unveraenderlich'); END;`);

  db.exec(`CREATE TABLE IF NOT EXISTS export_nachweise (
    id TEXT PRIMARY KEY,
    job_id INTEGER NOT NULL UNIQUE REFERENCES jobs(id),
    sha256 TEXT NOT NULL,
    manifest TEXT NOT NULL,
    erstellt_am TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS archiv_quittungen (
    export_id TEXT PRIMARY KEY REFERENCES export_nachweise(id),
    dokument_id TEXT NOT NULL UNIQUE,
    task_id TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    bestaetigt_am TEXT NOT NULL
  );`);
  for (const table of ['export_nachweise', 'archiv_quittungen']) {
    for (const action of ['UPDATE', 'DELETE']) {
      db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_no_${action} BEFORE ${action} ON ${table}
        BEGIN SELECT RAISE(ABORT, '${table} ist unveraenderlich'); END;`);
    }
  }

  const tables = {
    person_berechtigungen: 'person_id', konten: 'id', debitoren: 'id',
    debitor_ibans: 'id', zuweisungsregeln: 'id', admin_config: 'key',
    personen: 'churchtools_person_id', jobs: 'id', freigaben: 'id',
    export_nachweise: 'id', archiv_quittungen: 'export_id',
  };
  // Triggers make the event part of the same statement/transaction as its mutation.
  for (const [table, key] of Object.entries(tables)) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    function snapshot(prefix) {
      return `json_object(${columns.flatMap((column) => [
        `'${column}'`, table === 'admin_config' && column === 'value'
          ? `CASE WHEN lower(${prefix}.key) GLOB '*pass*' OR lower(${prefix}.key) GLOB '*secret*' OR lower(${prefix}.key) GLOB '*token*' THEN '[redacted]' ELSE ${prefix}.value END`
          : `${prefix}."${column}"`,
      ]).join(',')})`;
    }
    for (const action of ['INSERT', 'UPDATE', 'DELETE']) {
      const prefix = action === 'DELETE' ? 'OLD' : 'NEW';
      db.exec(`CREATE TRIGGER IF NOT EXISTS audit_${table}_${action} AFTER ${action} ON ${table}
        BEGIN INSERT INTO audit_ereignisse
          (zeitpunkt, person_id, person_name, objekt, objekt_id, aktion, vorher, nachher)
        VALUES (strftime('%Y-%m-%dT%H:%M:%fZ','now'), audit_actor_id(), audit_actor_name(),
          '${table}', CAST(${prefix}."${key}" AS TEXT), '${action}',
          ${action === 'INSERT' ? 'NULL' : snapshot('OLD')},
          ${action === 'DELETE' ? 'NULL' : snapshot('NEW')}); END;`);
    }
  }
}
