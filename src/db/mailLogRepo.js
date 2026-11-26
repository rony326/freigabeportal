// Mail-Protokoll (Tabelle `mail_log`): jede versendete, geplante oder eingereihte Mail samt Status.
// Die Zustellung selbst (Wiederholung, Sperren) steht in services/mailZustellung.js, die Bündelung in services/benachrichtigung.js.

// Protokolliert eine Mail mit ihrem Status ('versendet' | 'fehlgeschlagen' | 'geplant' | 'eingereiht'). @returns {number} id
export function logMailAttempt(db, { typ, jobId, empfaenger, betreff, text, status, fehlerDetails }) {
  const result = db
    .prepare(
      `INSERT INTO mail_log (typ, job_id, empfaenger, betreff, text, status, fehler_details, versucht_am)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(typ, jobId ?? null, empfaenger, betreff, text, status, fehlerDetails ?? null, new Date().toISOString());
  return Number(result.lastInsertRowid);
}

// Alle Einträge, neueste zuerst (Admin → Mails).
export function listMailLog(db) {
  return db.prepare('SELECT * FROM mail_log ORDER BY id DESC').all();
}

export function getMailLogById(db, id) {
  return db.prepare('SELECT * FROM mail_log WHERE id = ?').get(id) ?? null;
}

// Anhänge einer Mail in der Reihenfolge, in der sie eingereiht wurden. @returns {Array<{dateiname, pfad, sha256}>}
export function listMailAnhaenge(db, mailLogId) {
  return db
    .prepare('SELECT dateiname, pfad, sha256 FROM mail_anhaenge WHERE mail_log_id = ? ORDER BY id')
    .all(mailLogId)
    .map((zeile) => ({ ...zeile }));
}

// Löscht abgeschlossene Einträge, die älter als der Zeitpunkt sind, samt ihren Anhangszeilen (die Dateien bleiben liegen).
// @returns {number} Anzahl gelöschter Mails
export function pruneMailLogOlderThan(db, isoThreshold) {
  // Nur abgeschlossene Zeilen: 'eingereiht'/'geplant' sind noch zuzustellen und dürfen nie durch
  // die Aufbewahrungsfrist verloren gehen.
  const bedingung = "versucht_am < ? AND status IN ('versendet', 'fehlgeschlagen')";
  const eigeneTransaktion = !db.isTransaction;
  if (eigeneTransaktion) db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`DELETE FROM mail_anhaenge WHERE mail_log_id IN (SELECT id FROM mail_log WHERE ${bedingung})`).run(isoThreshold);
    const result = db.prepare(`DELETE FROM mail_log WHERE ${bedingung}`).run(isoThreshold);
    if (eigeneTransaktion) db.exec('COMMIT');
    return Number(result.changes);
  } catch (err) {
    if (eigeneTransaktion && db.isTransaction) db.exec('ROLLBACK');
    throw err;
  }
}

export function listGeplantMailsGruppiertNachEmpfaenger(db) {
  const jetzt = new Date().toISOString();
  const rows = db.prepare("SELECT * FROM mail_log WHERE status = 'geplant' AND (sperre_bis IS NULL OR sperre_bis <= ?) ORDER BY versucht_am, id").all(jetzt);
  const gruppen = new Map();
  for (const row of rows) {
    if (!gruppen.has(row.empfaenger)) gruppen.set(row.empfaenger, []);
    gruppen.get(row.empfaenger).push(row);
  }
  return gruppen;
}
