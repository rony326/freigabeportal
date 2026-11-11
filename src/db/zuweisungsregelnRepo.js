// Zuweisungsregeln (Tabelle `zuweisungsregeln`): Absender-Muster (E-Mail oder Domain) → Kreditor. Beim Eingang einer
// Rechnung per n8n wird damit Kreditor und Standardkonto vorgeschlagen (db/jobsRepo.js, Zuweisung). Verwaltung: Admin → Kreditoren.

export function createZuweisungsregel(db, { absenderMuster, kreditorId }) {
  const result = db.prepare('INSERT INTO zuweisungsregeln (absender_muster, kreditor_id) VALUES (?, ?)').run(absenderMuster, kreditorId);
  return Number(result.lastInsertRowid);
}

export function updateZuweisungsregel(db, id, { absenderMuster, kreditorId }) {
  db.prepare('UPDATE zuweisungsregeln SET absender_muster = ?, kreditor_id = ? WHERE id = ?').run(absenderMuster, kreditorId, id);
}

export function deleteZuweisungsregel(db, id) {
  db.prepare('DELETE FROM zuweisungsregeln WHERE id = ?').run(id);
}

export function getZuweisungsregelById(db, id) {
  return db.prepare('SELECT * FROM zuweisungsregeln WHERE id = ?').get(id) ?? null;
}

export function listZuweisungsregeln(db) {
  return db.prepare('SELECT * FROM zuweisungsregeln ORDER BY absender_muster').all();
}

// Doppelte Muster verhindert der Aufrufer (admin/kreditoren.js) anhand dieser Abfrage.
export function findZuweisungsregelByMuster(db, absenderMuster) {
  return db.prepare('SELECT * FROM zuweisungsregeln WHERE absender_muster = ?').get(absenderMuster) ?? null;
}
