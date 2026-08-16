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
  const result = db.prepare('DELETE FROM mail_log WHERE versucht_am < ?').run(isoThreshold);
  return Number(result.changes);
}
