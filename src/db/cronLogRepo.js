export function logCronLauf(db, { job, gestartetAm, beendetAm, status, details }) {
  const result = db
    .prepare('INSERT INTO cron_log (job, gestartet_am, beendet_am, status, details) VALUES (?, ?, ?, ?, ?)')
    .run(job, gestartetAm, beendetAm, status, details ?? null);
  return Number(result.lastInsertRowid);
}

export function listRecentCronLog(db, job, limit = 20) {
  return db.prepare('SELECT * FROM cron_log WHERE job = ? ORDER BY id DESC LIMIT ?').all(job, limit);
}

// Two-phase logging (start now, finish later) for jobs that need an overlap guard while they run
// — see hasRecentRunningCronLauf below. Mirrors startSyncLog/finishSyncLog/hasRecentRunningSync in
// syncLogRepo.js; unlike logCronLauf's single-shot insert (used by pool-erinnerungen and
// pdf-bereinigung, which never overlap-guard), these three are for jobs whose in-flight state
// needs to be visible to a concurrent invocation *before* the run finishes.
export function startCronLauf(db, job) {
  const result = db
    .prepare("INSERT INTO cron_log (job, gestartet_am, beendet_am, status, details) VALUES (?, ?, NULL, 'laufend', NULL)")
    .run(job, new Date().toISOString());
  return Number(result.lastInsertRowid);
}

export function finishCronLauf(db, id, { beendetAm, status, details }) {
  db.prepare('UPDATE cron_log SET beendet_am = ?, status = ?, details = ? WHERE id = ?').run(beendetAm, status, details ?? null, id);
}

export function hasRecentRunningCronLauf(db, job, staleAfterMs = 10 * 60 * 1000) {
  const row = db.prepare("SELECT gestartet_am FROM cron_log WHERE job = ? AND status = 'laufend' ORDER BY id DESC LIMIT 1").get(job);
  if (!row) return false;
  return Date.now() - new Date(row.gestartet_am).getTime() < staleAfterMs;
}
