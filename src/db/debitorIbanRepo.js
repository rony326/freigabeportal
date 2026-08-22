export function createDebitorIban(db, { debitorId, iban, quelle = 'manuell' }) {
  const result = db
    .prepare('INSERT INTO debitor_ibans (debitor_id, iban, quelle, erstellt_am) VALUES (?, ?, ?, ?)')
    .run(debitorId, iban, quelle, new Date().toISOString());
  return Number(result.lastInsertRowid);
}

export function deleteDebitorIban(db, id) {
  db.prepare('DELETE FROM debitor_ibans WHERE id = ?').run(id);
}

export function getDebitorIbanById(db, id) {
  return db.prepare('SELECT * FROM debitor_ibans WHERE id = ?').get(id) ?? null;
}

export function listDebitorIbansByDebitor(db, debitorId) {
  return db.prepare('SELECT * FROM debitor_ibans WHERE debitor_id = ? ORDER BY iban').all(debitorId);
}

export function listDebitorIbansAll(db) {
  return db.prepare('SELECT * FROM debitor_ibans ORDER BY iban').all();
}

export function findDebitorIbanByIban(db, iban) {
  return db.prepare('SELECT * FROM debitor_ibans WHERE iban = ?').get(iban) ?? null;
}
