export function createSpesenabrechnung(db, { eingereichtVon, eingereichtAm, titel }) {
  const result = db
    .prepare('INSERT INTO spesenabrechnungen (eingereicht_von, eingereicht_am, titel) VALUES (?, ?, ?)')
    .run(eingereichtVon, eingereichtAm, titel ?? null);
  return Number(result.lastInsertRowid);
}

export function getSpesenabrechnungById(db, id) {
  if (id == null) return null;
  return db.prepare('SELECT * FROM spesenabrechnungen WHERE id = ?').get(id) ?? null;
}
