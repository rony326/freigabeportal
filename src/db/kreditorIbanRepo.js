export function createKreditorIban(db, { kreditorId, iban, quelle = 'manuell' }) {
  const result = db
    .prepare('INSERT INTO kreditor_ibans (kreditor_id, iban, quelle, erstellt_am) VALUES (?, ?, ?, ?)')
    .run(kreditorId, iban, quelle, new Date().toISOString());
  return Number(result.lastInsertRowid);
}

export function deleteKreditorIban(db, id) {
  db.prepare('DELETE FROM kreditor_ibans WHERE id = ?').run(id);
}

export function getKreditorIbanById(db, id) {
  return db.prepare('SELECT * FROM kreditor_ibans WHERE id = ?').get(id) ?? null;
}

export function listKreditorIbansByKreditor(db, kreditorId) {
  return db.prepare('SELECT * FROM kreditor_ibans WHERE kreditor_id = ? ORDER BY iban').all(kreditorId);
}

export function listKreditorIbansAll(db) {
  return db.prepare('SELECT * FROM kreditor_ibans ORDER BY iban').all();
}

export function findKreditorIbanByIban(db, iban) {
  return db.prepare('SELECT * FROM kreditor_ibans WHERE iban = ?').get(iban) ?? null;
}
