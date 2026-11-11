export const ZAHLUNGSARTEN = ['ueberweisung', 'dauerauftrag', 'lastschrift', 'kreditkarte'];
export const ZAHLUNGSART_LABEL = {
  ueberweisung: 'Überweisung',
  dauerauftrag: 'Dauerauftrag',
  lastschrift: 'Lastschrift',
  kreditkarte: 'Kreditkarte',
};

function pruefeZahlungsart(zahlungsart) {
  if (!ZAHLUNGSARTEN.includes(zahlungsart)) throw new Error(`Ungültige Zahlungsart: ${zahlungsart}`);
}

export function brauchtIban(zahlungsart) {
  return zahlungsart === 'ueberweisung' || zahlungsart === 'dauerauftrag';
}

export function createKreditor(db, { name, kontoId, zahlungsart = 'ueberweisung', betragSchwankt = false }) {
  pruefeZahlungsart(zahlungsart);
  const result = db.prepare('INSERT INTO kreditoren (name, konto_id, aktiv, zahlungsart, betrag_schwankt) VALUES (?, ?, 1, ?, ?)')
    .run(name, kontoId || null, zahlungsart, betragSchwankt ? 1 : 0);
  return Number(result.lastInsertRowid);
}

// zahlungsart/betragSchwankt sind optional: wer sie weglässt (alte Aufrufer mit nur name/kontoId),
// ändert den bisherigen Wert nicht.
export function updateKreditor(db, id, { name, kontoId, zahlungsart, betragSchwankt }) {
  if (zahlungsart !== undefined) pruefeZahlungsart(zahlungsart);
  db.prepare(`UPDATE kreditoren SET name = ?, konto_id = ?,
      zahlungsart = COALESCE(?, zahlungsart), betrag_schwankt = COALESCE(?, betrag_schwankt) WHERE id = ?`)
    .run(name, kontoId || null, zahlungsart ?? null, betragSchwankt === undefined ? null : (betragSchwankt ? 1 : 0), id);
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

export function istKreditorVollstaendig(db, kreditor) {
  if (!brauchtIban(kreditor.zahlungsart)) return true;
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM kreditor_ibans WHERE kreditor_id = ?').get(kreditor.id);
  return n > 0;
}

// Aktive Kreditoren, die für Zuweisung/Kontierung taugen (IBAN vorhanden, wo sie nötig ist).
export function listKreditorenWaehlbar(db) {
  return listKreditoren(db).filter((k) => istKreditorVollstaendig(db, k));
}
