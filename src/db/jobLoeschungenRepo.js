// Protokoll endgültig gelöschter Vorgänge (Tabelle `job_loeschungen`). Bewusst ohne Fremdschlüssel auf `jobs`,
// damit der Nachweis die gelöschte Zeile überlebt.

// Hält fest, wer welchen Vorgang mit welcher Begründung gelöscht hat. @returns {number} id
export function logJobLoeschung(db, { jobId, dateiname, geloeschtVon, begruendung }) {
  const result = db
    .prepare(
      `INSERT INTO job_loeschungen (job_id, dateiname, geloescht_von, begruendung, zeitpunkt)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(jobId, dateiname, geloeschtVon, begruendung, new Date().toISOString());
  return Number(result.lastInsertRowid);
}

// Alle Löschungen, neueste zuerst.
export function listJobLoeschungen(db) {
  return db.prepare('SELECT * FROM job_loeschungen ORDER BY id DESC').all();
}
