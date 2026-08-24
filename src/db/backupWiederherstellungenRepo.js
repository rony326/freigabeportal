export function logBackupWiederherstellung(db, { dateiname, wiederhergestelltVon }) {
  const result = db
    .prepare(
      `INSERT INTO backup_wiederherstellungen (dateiname, wiederhergestellt_von, zeitpunkt)
       VALUES (?, ?, ?)`
    )
    .run(dateiname, wiederhergestelltVon, new Date().toISOString());
  return Number(result.lastInsertRowid);
}

export function listBackupWiederherstellungen(db) {
  return db.prepare('SELECT * FROM backup_wiederherstellungen ORDER BY id DESC').all();
}
