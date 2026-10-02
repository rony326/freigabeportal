export function logMailAttempt(db, { typ, jobId, empfaenger, betreff, text, status, fehlerDetails }) {
  const result = db
    .prepare(
      `INSERT INTO mail_log (typ, job_id, empfaenger, betreff, text, status, fehler_details, versucht_am)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(typ, jobId ?? null, empfaenger, betreff, text, status, fehlerDetails ?? null, new Date().toISOString());
  return Number(result.lastInsertRowid);
}

export function listMailLog(db) {
  return db.prepare('SELECT * FROM mail_log ORDER BY id DESC').all();
}

export function getMailLogById(db, id) {
  return db.prepare('SELECT * FROM mail_log WHERE id = ?').get(id) ?? null;
}

export function pruneMailLogOlderThan(db, isoThreshold) {
  // Nur abgeschlossene Zeilen: 'eingereiht'/'geplant' sind noch zuzustellen und dürfen nie durch
  // die Aufbewahrungsfrist verloren gehen.
  const result = db.prepare("DELETE FROM mail_log WHERE versucht_am < ? AND status IN ('versendet', 'fehlgeschlagen')").run(isoThreshold);
  return Number(result.changes);
}

export function listGeplantMailsGruppiertNachEmpfaenger(db) {
  const jetzt = new Date().toISOString();
  const rows = db.prepare("SELECT * FROM mail_log WHERE status = 'geplant' AND (sperre_bis IS NULL OR sperre_bis <= ?) ORDER BY versucht_am, id").all(jetzt);
  const gruppen = new Map();
  for (const row of rows) {
    if (!gruppen.has(row.empfaenger)) gruppen.set(row.empfaenger, []);
    gruppen.get(row.empfaenger).push(row);
  }
  return gruppen;
}
