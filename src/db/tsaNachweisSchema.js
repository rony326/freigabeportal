// Aufbewahrung der bei einer Zeitstempelpruefung verwendeten Zertifikats- und Sperrevidenz
// (services/tsaNachweis.js). Objekte sind inhaltsadressiert (SHA-256 des DER) und dedupliziert;
// jeder Nachweis ist einem Job, einer Dokumentart und dem SHA-256 der gestempelten Datei
// zugeordnet. Beide Tabellen sind lokal gegen UPDATE/DELETE gesperrt.
export function migrateTsaNachweisSchema(db) {
  db.exec('SAVEPOINT tsa_nachweis_schema');
  try {
    db.exec(`
    CREATE TABLE IF NOT EXISTS tsa_evidenz_objekte (
      sha256 TEXT PRIMARY KEY CHECK(length(sha256) = 64),
      art TEXT NOT NULL CHECK(art IN ('zertifikat', 'sperrliste', 'zeitstempel_token')),
      der BLOB NOT NULL,
      erfasst_am TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tsa_pruefnachweise (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL REFERENCES jobs(id),
      bezug TEXT NOT NULL CHECK(bezug IN ('einzel', 'gruppe')),
      dokument_sha256 TEXT NOT NULL CHECK(length(dokument_sha256) = 64),
      geprueft_am TEXT NOT NULL,
      kettenpruefung TEXT NOT NULL CHECK(kettenpruefung IN ('geprueft', 'nicht_konfiguriert')),
      nachweis TEXT NOT NULL,
      nachweis_sha256 TEXT NOT NULL CHECK(length(nachweis_sha256) = 64),
      UNIQUE(job_id, bezug, dokument_sha256)
    );
    `);
    for (const table of ['tsa_evidenz_objekte', 'tsa_pruefnachweise']) {
      for (const action of ['UPDATE', 'DELETE']) {
        db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_no_${action} BEFORE ${action} ON ${table}
          BEGIN SELECT RAISE(ABORT, '${table} ist unveraenderlich'); END;`);
      }
    }
    db.exec('RELEASE tsa_nachweis_schema');
  } catch (err) {
    db.exec('ROLLBACK TO tsa_nachweis_schema; RELEASE tsa_nachweis_schema');
    throw err;
  }
}
