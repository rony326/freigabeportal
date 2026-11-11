// Kreditoren = Lieferanten/Rechnungssteller (Tabelle `kreditoren`): Name, Standardkonto, Zahlungsart und ob die
// Beträge schwanken. IBANs stehen in kreditorIbanRepo.js. Verwaltung: Admin → Kreditoren (bis 2026-09 "Debitoren",
// siehe docs/kreditoren-statt-debitoren.md). Fachlich: docs/qr-bill-und-betrugserkennung.md.

// Erlaubte Zahlungsarten; Überweisung und Dauerauftrag brauchen mindestens eine hinterlegte IBAN (brauchtIban).
export const ZAHLUNGSARTEN = ['ueberweisung', 'dauerauftrag', 'lastschrift', 'kreditkarte'];
export const ZAHLUNGSART_LABEL = {
  ueberweisung: 'Überweisung',
  dauerauftrag: 'Dauerauftrag',
  lastschrift: 'Lastschrift',
  kreditkarte: 'Kreditkarte',
};

// Wirft bei einer unbekannten Zahlungsart.
function pruefeZahlungsart(zahlungsart) {
  if (!ZAHLUNGSARTEN.includes(zahlungsart)) throw new Error(`Ungültige Zahlungsart: ${zahlungsart}`);
}

// true, wenn für diese Zahlungsart eine IBAN Pflicht ist (Lastschrift und Kreditkarte brauchen keine).
export function brauchtIban(zahlungsart) {
  return zahlungsart === 'ueberweisung' || zahlungsart === 'dauerauftrag';
}

// @returns {number} id des neuen Kreditors (aktiv)
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

// Kreditoren werden nur (de)aktiviert, nie gelöscht.
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

// true, wenn der Kreditor für Zuweisung/Kontierung taugt (IBAN vorhanden, wo Pflicht).
export function istKreditorVollstaendig(db, kreditor) {
  if (!brauchtIban(kreditor.zahlungsart)) return true;
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM kreditor_ibans WHERE kreditor_id = ?').get(kreditor.id);
  return n > 0;
}

// Aktive Kreditoren, die für Zuweisung/Kontierung taugen (IBAN vorhanden, wo sie nötig ist).
export function listKreditorenWaehlbar(db) {
  return listKreditoren(db).filter((k) => istKreditorVollstaendig(db, k));
}
