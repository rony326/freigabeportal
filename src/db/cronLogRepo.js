// Ausführungsprotokoll der Hintergrund-Jobs (Tabelle `cron_log`); angezeigt unter Admin → Geplante Jobs.
// Der Personen-Sync hat mit `sync_log` ein eigenes, detaillierteres Protokoll (syncLogRepo.js).

// Einmaliges Protokollieren eines bereits beendeten Laufs. @returns {number} id
export function logCronLauf(db, { job, gestartetAm, beendetAm, status, details }) {
  const result = db
    .prepare('INSERT INTO cron_log (job, gestartet_am, beendet_am, status, details) VALUES (?, ?, ?, ?, ?)')
    .run(job, gestartetAm, beendetAm, status, details ?? null);
  return Number(result.lastInsertRowid);
}

// Die letzten `limit` Läufe eines Jobs, neueste zuerst.
export function listRecentCronLog(db, job, limit = 20) {
  return db.prepare('SELECT * FROM cron_log WHERE job = ? ORDER BY id DESC LIMIT ?').all(job, limit);
}

// Zweiphasiges Protokollieren (jetzt starten, später abschliessen) für Jobs, die während des Laufs einen Überlappungsschutz
// brauchen — siehe hasRecentRunningCronLauf unten. Entspricht startSyncLog/finishSyncLog/hasRecentRunningSync in
// syncLogRepo.js. Anders als das einmalige Einfügen von logCronLauf (genutzt von pool-erinnerungen und pdf-bereinigung,
// die keinen Überlappungsschutz haben) sind diese drei für Jobs gedacht, deren laufender Zustand für einen
// gleichzeitigen Aufruf sichtbar sein muss, *bevor* der Lauf endet.
export function startCronLauf(db, job) {
  const result = db
    .prepare("INSERT INTO cron_log (job, gestartet_am, beendet_am, status, details) VALUES (?, ?, NULL, 'laufend', NULL)")
    .run(job, new Date().toISOString());
  return Number(result.lastInsertRowid);
}

// Schliesst einen mit startCronLauf begonnenen Lauf ab.
export function finishCronLauf(db, id, { beendetAm, status, details }) {
  db.prepare('UPDATE cron_log SET beendet_am = ?, status = ?, details = ? WHERE id = ?').run(beendetAm, status, details ?? null, id);
}

// true, wenn der Job laut Protokoll noch läuft (jünger als `staleAfterMs`; ältere "laufend"-Einträge gelten als abgestürzt).
export function hasRecentRunningCronLauf(db, job, staleAfterMs = 10 * 60 * 1000) {
  const row = db.prepare("SELECT gestartet_am FROM cron_log WHERE job = ? AND status = 'laufend' ORDER BY id DESC LIMIT 1").get(job);
  if (!row) return false;
  return Date.now() - new Date(row.gestartet_am).getTime() < staleAfterMs;
}
