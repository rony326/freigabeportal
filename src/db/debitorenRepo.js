export function createDebitor(db, { name, kontoId }) {
  const result = db.prepare('INSERT INTO debitoren (name, konto_id, aktiv) VALUES (?, ?, 1)').run(name, kontoId || null);
  return Number(result.lastInsertRowid);
}

export function updateDebitor(db, id, { name, kontoId }) {
  db.prepare('UPDATE debitoren SET name = ?, konto_id = ? WHERE id = ?').run(name, kontoId || null, id);
}

export function deactivateDebitor(db, id) {
  db.prepare('UPDATE debitoren SET aktiv = 0 WHERE id = ?').run(id);
}

export function getDebitorById(db, id) {
  return db.prepare('SELECT * FROM debitoren WHERE id = ?').get(id) ?? null;
}

export function listDebitoren(db, { includeInactive = false } = {}) {
  if (includeInactive) {
    return db.prepare('SELECT * FROM debitoren ORDER BY name').all();
  }
  return db.prepare('SELECT * FROM debitoren WHERE aktiv = 1 ORDER BY name').all();
}
