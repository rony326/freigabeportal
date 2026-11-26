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

// Alle Positionen (Vorgänge) einer Abrechnung in Einreichungsreihenfolge.
export function listPositionen(db, abrechnungId) {
  return db.prepare('SELECT * FROM jobs WHERE spesenabrechnung_id = ? ORDER BY id').all(abrechnungId);
}

// Hält fest, was aus der Bestätigung geworden ist (`vermerk`, siehe CHECK in schema.sql). `jetzt` in Millisekunden.
// @returns {boolean} false, wenn schon entschieden war (dann bleibt der erste Eintrag)
export function setzeBestaetigung(db, abrechnungId, vermerk, jetzt) {
  return db
    .prepare('UPDATE spesenabrechnungen SET bestaetigung_am = ?, bestaetigung_vermerk = ? WHERE id = ? AND bestaetigung_am IS NULL')
    .run(new Date(jetzt).toISOString(), vermerk, abrechnungId).changes > 0;
}
