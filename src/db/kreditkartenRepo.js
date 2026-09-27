export function createKreditkarte(db, { bezeichnung, karteEndziffern, karteninhaberName, verantwortlichId, erfassungOffen, absenderMuster }) {
  const result = db
    .prepare(
      `INSERT INTO kreditkarten (bezeichnung, karte_endziffern, karteninhaber_name, verantwortlich_id, erfassung_offen, absender_muster, erstellt_am)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(bezeichnung, karteEndziffern || null, karteninhaberName || null, verantwortlichId, erfassungOffen ? 1 : 0, absenderMuster || null, new Date().toISOString());
  return Number(result.lastInsertRowid);
}

export function updateKreditkarte(db, id, { bezeichnung, karteEndziffern, karteninhaberName, verantwortlichId, erfassungOffen, absenderMuster }) {
  db.prepare(
    `UPDATE kreditkarten SET bezeichnung = ?, karte_endziffern = ?, karteninhaber_name = ?, verantwortlich_id = ?, erfassung_offen = ?, absender_muster = ?
     WHERE id = ?`
  ).run(bezeichnung, karteEndziffern || null, karteninhaberName || null, verantwortlichId, erfassungOffen ? 1 : 0, absenderMuster || null, id);
}

export function setKreditkarteAktiv(db, id, aktiv) {
  db.prepare('UPDATE kreditkarten SET aktiv = ? WHERE id = ?').run(aktiv ? 1 : 0, id);
}

export function getKreditkarteById(db, id) {
  return db.prepare('SELECT * FROM kreditkarten WHERE id = ?').get(id) ?? null;
}

export function listKreditkarten(db, { includeInactive = false } = {}) {
  if (includeInactive) return db.prepare('SELECT * FROM kreditkarten ORDER BY bezeichnung, id').all();
  return db.prepare('SELECT * FROM kreditkarten WHERE aktiv = 1 ORDER BY bezeichnung, id').all();
}

export function listErfasserIds(db, kreditkarteId) {
  return db.prepare('SELECT person_id FROM kreditkarte_erfasser WHERE kreditkarte_id = ? ORDER BY person_id').all(kreditkarteId).map((r) => r.person_id);
}

// Ersetzt die ganze Liste in einem Rutsch -- das Admin-Formular sendet immer die vollständige
// Auswahl, nie ein Delta.
export function setErfasser(db, kreditkarteId, personIds) {
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM kreditkarte_erfasser WHERE kreditkarte_id = ?').run(kreditkarteId);
    const insert = db.prepare('INSERT OR IGNORE INTO kreditkarte_erfasser (kreditkarte_id, person_id) VALUES (?, ?)');
    for (const personId of personIds) insert.run(kreditkarteId, personId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
