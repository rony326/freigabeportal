export function createZuweisungsregel(db, { absenderMuster, debitorId }) {
  const result = db.prepare('INSERT INTO zuweisungsregeln (absender_muster, debitor_id) VALUES (?, ?)').run(absenderMuster, debitorId);
  return Number(result.lastInsertRowid);
}

export function updateZuweisungsregel(db, id, { absenderMuster, debitorId }) {
  db.prepare('UPDATE zuweisungsregeln SET absender_muster = ?, debitor_id = ? WHERE id = ?').run(absenderMuster, debitorId, id);
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

export function findZuweisungsregelByMuster(db, absenderMuster) {
  return db.prepare('SELECT * FROM zuweisungsregeln WHERE absender_muster = ?').get(absenderMuster) ?? null;
}
