export function createFreigabe(db, { jobId, personId, rolle, zeitpunkt, ip, interessenskonflikt, kommentar, eskaliertVon, vertretungFuer = null }) {
  const result = db
    .prepare(
      `INSERT INTO freigaben (job_id, person_id, rolle, zeitpunkt, ip, interessenskonflikt, kommentar, eskaliert_von, vertretung_fuer)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(jobId, personId, rolle, zeitpunkt, ip, interessenskonflikt ? 1 : 0, kommentar ?? null, eskaliertVon ?? null, vertretungFuer ?? null);
  return Number(result.lastInsertRowid);
}

export function listFreigabenByJob(db, jobId) {
  return db.prepare('SELECT * FROM freigaben WHERE job_id = ? ORDER BY id').all(jobId);
}
