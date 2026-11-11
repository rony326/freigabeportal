// Protokoll der Datenbank-Wiederherstellungen (Tabelle `backup_wiederherstellungen`, siehe docs/offline-restore.md).

// Hält fest, welche Sicherungsdatei von welcher Person wiederhergestellt wurde. @returns {number} id
export function logBackupWiederherstellung(db, { dateiname, wiederhergestelltVon }) {
  const result = db
    .prepare(
      `INSERT INTO backup_wiederherstellungen (dateiname, wiederhergestellt_von, zeitpunkt)
       VALUES (?, ?, ?)`
    )
    .run(dateiname, wiederhergestelltVon, new Date().toISOString());
  return Number(result.lastInsertRowid);
}

// Alle Wiederherstellungen, neueste zuerst.
export function listBackupWiederherstellungen(db) {
  return db.prepare('SELECT * FROM backup_wiederherstellungen ORDER BY id DESC').all();
}
