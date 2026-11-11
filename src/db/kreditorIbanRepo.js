// IBANs je Kreditor (Tabelle `kreditor_ibans`; quelle: 'manuell' | 'qr' …). Grundlage des IBAN-Abgleichs der
// Betrugserkennung (services/betrugspruefung.js, docs/qr-bill-und-betrugserkennung.md). IBANs sind normalisiert (ibanUtils.js).

// @returns {number} id
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

// Sucht eine IBAN über alle Kreditoren hinweg (Erkennung, ob sie schon einem anderen Kreditor gehört).
export function findKreditorIbanByIban(db, iban) {
  return db.prepare('SELECT * FROM kreditor_ibans WHERE iban = ?').get(iban) ?? null;
}
