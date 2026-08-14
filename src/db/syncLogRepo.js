export function startSyncLog(db) {
  const result = db.prepare("INSERT INTO sync_log (gestartet_am, status) VALUES (?, 'laufend')").run(new Date().toISOString());
  return Number(result.lastInsertRowid);
}

export function finishSyncLog(db, id, { status, anzahlUpserted = null, anzahlDeaktiviert = null, fehlerDetails = null }) {
  db.prepare(
    'UPDATE sync_log SET beendet_am = ?, status = ?, anzahl_upserted = ?, anzahl_deaktiviert = ?, fehler_details = ? WHERE id = ?'
  ).run(new Date().toISOString(), status, anzahlUpserted, anzahlDeaktiviert, fehlerDetails, id);
}

export function hasRecentRunningSync(db, staleAfterMs = 10 * 60 * 1000) {
  const row = db.prepare("SELECT gestartet_am FROM sync_log WHERE status = 'laufend' ORDER BY id DESC LIMIT 1").get();
  if (!row) return false;
  return Date.now() - new Date(row.gestartet_am).getTime() < staleAfterMs;
}
