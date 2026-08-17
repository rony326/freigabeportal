export function logCronLauf(db, { job, gestartetAm, beendetAm, status, details }) {
  const result = db
    .prepare('INSERT INTO cron_log (job, gestartet_am, beendet_am, status, details) VALUES (?, ?, ?, ?, ?)')
    .run(job, gestartetAm, beendetAm, status, details ?? null);
  return Number(result.lastInsertRowid);
}

export function listRecentCronLog(db, job, limit = 20) {
  return db.prepare('SELECT * FROM cron_log WHERE job = ? ORDER BY id DESC LIMIT ?').all(job, limit);
}
