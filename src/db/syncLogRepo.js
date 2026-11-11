// Protokoll des ChurchTools-Personen-Syncs (Tabelle `sync_log`), angezeigt unter Admin → Sync. Läuft als zweiphasiges
// Protokoll (start → finish), damit sich zwei Läufe nicht überlappen (`hasRecentRunningSync`). Details: docs/personen-sync.md.

// Beginnt einen Lauf (Status 'laufend'). @returns {number} id
export function startSyncLog(db) {
  const result = db.prepare("INSERT INTO sync_log (gestartet_am, status) VALUES (?, 'laufend')").run(new Date().toISOString());
  return Number(result.lastInsertRowid);
}

// Schliesst den Lauf ab (Status, Zähler, Fehlertext).
export function finishSyncLog(db, id, { status, anzahlUpserted = null, anzahlDeaktiviert = null, fehlerDetails = null }) {
  db.prepare(
    'UPDATE sync_log SET beendet_am = ?, status = ?, anzahl_upserted = ?, anzahl_deaktiviert = ?, fehler_details = ? WHERE id = ?'
  ).run(new Date().toISOString(), status, anzahlUpserted, anzahlDeaktiviert, fehlerDetails, id);
}

// true, wenn ein Lauf noch läuft (jünger als `staleAfterMs`; ältere "laufend"-Zeilen gelten als abgestürzt).
export function hasRecentRunningSync(db, staleAfterMs = 10 * 60 * 1000) {
  const row = db.prepare("SELECT gestartet_am FROM sync_log WHERE status = 'laufend' ORDER BY id DESC LIMIT 1").get();
  if (!row) return false;
  return Date.now() - new Date(row.gestartet_am).getTime() < staleAfterMs;
}

// Die letzten Läufe, neueste zuerst.
export function listRecentSyncLogs(db, limit = 20) {
  return db.prepare('SELECT * FROM sync_log ORDER BY id DESC LIMIT ?').all(limit);
}
