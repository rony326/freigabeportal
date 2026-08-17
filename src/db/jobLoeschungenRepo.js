export function logJobLoeschung(db, { jobId, dateiname, geloeschtVon, begruendung }) {
  const result = db
    .prepare(
      `INSERT INTO job_loeschungen (job_id, dateiname, geloescht_von, begruendung, zeitpunkt)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(jobId, dateiname, geloeschtVon, begruendung, new Date().toISOString());
  return Number(result.lastInsertRowid);
}

export function listJobLoeschungen(db) {
  return db.prepare('SELECT * FROM job_loeschungen ORDER BY id DESC').all();
}
