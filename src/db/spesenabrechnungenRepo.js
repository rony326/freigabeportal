// Spesenabrechnungen (Tabelle `spesenabrechnungen`): Sammelkopf, unter dem eine Person mehrere Spesenbelege (Jobs
// mit quelle 'spesen') gemeinsam einreicht. Fachlich: docs/spesen-einreichung.md.

// @returns {number} id der neuen Abrechnung
export function createSpesenabrechnung(db, { eingereichtVon, eingereichtAm, titel }) {
  const result = db
    .prepare('INSERT INTO spesenabrechnungen (eingereicht_von, eingereicht_am, titel) VALUES (?, ?, ?)')
    .run(eingereichtVon, eingereichtAm, titel ?? null);
  return Number(result.lastInsertRowid);
}

// @returns {object|null} null auch bei id null/undefined
export function getSpesenabrechnungById(db, id) {
  if (id == null) return null;
  return db.prepare('SELECT * FROM spesenabrechnungen WHERE id = ?').get(id) ?? null;
}
