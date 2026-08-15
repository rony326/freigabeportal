export function createFreigabe(db, { jobId, personId, rolle, zeitpunkt, ip, interessenskonflikt, kommentar, eskaliertVon }) {
  const result = db
    .prepare(
      `INSERT INTO freigaben (job_id, person_id, rolle, zeitpunkt, ip, interessenskonflikt, kommentar, eskaliert_von)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(jobId, personId, rolle, zeitpunkt, ip, interessenskonflikt ? 1 : 0, kommentar ?? null, eskaliertVon ?? null);
  return Number(result.lastInsertRowid);
}

export function listFreigabenByJob(db, jobId) {
  return db.prepare('SELECT * FROM freigaben WHERE job_id = ? ORDER BY id').all(jobId);
}
