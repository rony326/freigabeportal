// Bewusst bestätigte Auffälligkeiten bei der Kontierung (Prüf-Popup). Append-only: UPDATE/DELETE
// bricht ein Trigger ab (schema.sql). Befunde: services/betrugspruefung.js.

function mitBefunden(row) {
  if (!row) return null;
  const { befunde_json: befundeJson, ...rest } = row;
  return { ...rest, befunde: JSON.parse(befundeJson) };
}

/** @returns {number} id der neuen Zeile */
export function speichereBestaetigung(db, { jobId, personId, befunde, bemerkung = null }) {
  const result = db
    .prepare('INSERT INTO kontierung_auffaelligkeiten (job_id, person_id, zeitpunkt, befunde_json, bemerkung) VALUES (?, ?, ?, ?, ?)')
    .run(jobId, personId, new Date().toISOString(), JSON.stringify(befunde), bemerkung || null);
  return Number(result.lastInsertRowid);
}

// Neueste zuerst.
export function listBestaetigungen(db, jobId) {
  return db
    .prepare('SELECT * FROM kontierung_auffaelligkeiten WHERE job_id = ? ORDER BY zeitpunkt DESC, id DESC')
    .all(jobId)
    .map(mitBefunden);
}

export function letzteBestaetigung(db, jobId) {
  return listBestaetigungen(db, jobId)[0] ?? null;
}
