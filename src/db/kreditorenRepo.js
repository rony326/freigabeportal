export function createKreditor(db, { name, kontoId }) {
  const result = db.prepare('INSERT INTO kreditoren (name, konto_id, aktiv) VALUES (?, ?, 1)').run(name, kontoId || null);
  return Number(result.lastInsertRowid);
}

export function updateKreditor(db, id, { name, kontoId }) {
  db.prepare('UPDATE kreditoren SET name = ?, konto_id = ? WHERE id = ?').run(name, kontoId || null, id);
}

export function deactivateKreditor(db, id) {
  db.prepare('UPDATE kreditoren SET aktiv = 0 WHERE id = ?').run(id);
}

export function activateKreditor(db, id) {
  db.prepare('UPDATE kreditoren SET aktiv = 1 WHERE id = ?').run(id);
}

export function getKreditorById(db, id) {
  return db.prepare('SELECT * FROM kreditoren WHERE id = ?').get(id) ?? null;
}

export function listKreditoren(db, { includeInactive = false } = {}) {
  if (includeInactive) {
    return db.prepare('SELECT * FROM kreditoren ORDER BY name').all();
  }
  return db.prepare('SELECT * FROM kreditoren WHERE aktiv = 1 ORDER BY name').all();
}
