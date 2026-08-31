export function createSpesenabrechnung(db, { eingereichtVon, eingereichtAm, titel }) {
  const result = db
    .prepare('INSERT INTO spesenabrechnungen (eingereicht_von, eingereicht_am, titel) VALUES (?, ?, ?)')
    .run(eingereichtVon, eingereichtAm, titel ?? null);
  return Number(result.lastInsertRowid);
}
