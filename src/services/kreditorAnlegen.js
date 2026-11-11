// Gemeinsame Prüfung und Anlage von Kreditoren (Lieferanten) für das Admin-Formular und die Schnellanlage in der Kontierung.

import { getKontoById, kontoErlaubtFuerTyp } from '../db/kontenRepo.js';
import { createKreditor, ZAHLUNGSARTEN, brauchtIban } from '../db/kreditorenRepo.js';
import { createKreditorIban, findKreditorIbanByIban } from '../db/kreditorIbanRepo.js';
import { normalizeIban, isValidIbanInternational } from './ibanUtils.js';

export const IBAN_PFLICHT_FEHLER = 'Bei Überweisung und Dauerauftrag ist mindestens eine IBAN Pflicht.';
export const IBAN_UNGUELTIG_FEHLER = 'IBAN ist ungültig (Prüfziffer oder Länge stimmt nicht).';
export const IBAN_BEREITS_ZUGEORDNET_FEHLER = 'Diese IBAN ist bereits einem Lieferanten zugeordnet.';

// Gemeinsame Prüfung für das Anlegen eines Lieferanten (Admin und Kontierungs-Schnellanlage).
// (Siehe Kommentar oben.)
export const STANDARD_KONTO_FEHLER = 'Das Standard-Konto muss Rechnungen erlauben (Buchungsart «Rechnung» oder «Rechnung / Gutschrift»).';

// Das Standard-Konto steuert eingehende Rechnungen: ein reines Gutschrift-Konto ist dafür nicht zulässig.
export function pruefeStandardKonto(db, kontoId) {
  if (!kontoId) return null;
  const konto = getKontoById(db, Number(kontoId));
  return konto && !kontoErlaubtFuerTyp(konto, 'rechnung') ? STANDARD_KONTO_FEHLER : null;
}

/**
 * Prüft die Eingaben für einen neuen Lieferanten (Name, Zahlungsart, IBAN-Pflicht und -Gültigkeit, Standardkonto).
 * @returns {{errors: string[], normalizedIban: string}}
 */
export function pruefeNeuenKreditor(db, { name, zahlungsart, iban, kontoId = null }) {
  const normalizedIban = normalizeIban(iban);
  const errors = [];
  const kontoFehler = pruefeStandardKonto(db, kontoId);
  if (kontoFehler) errors.push(kontoFehler);
  if (!name || !name.trim()) errors.push('Name ist ein Pflichtfeld.');
  if (!ZAHLUNGSARTEN.includes(zahlungsart)) {
    errors.push('Zahlungsart ist ungültig.');
  } else if (brauchtIban(zahlungsart) && !normalizedIban) {
    errors.push(IBAN_PFLICHT_FEHLER);
  }
  if (normalizedIban) {
    if (!isValidIbanInternational(normalizedIban)) errors.push(IBAN_UNGUELTIG_FEHLER);
    else if (findKreditorIbanByIban(db, normalizedIban)) errors.push(IBAN_BEREITS_ZUGEORDNET_FEHLER);
  }
  return { errors, normalizedIban };
}

// Kreditor und erste IBAN atomar: scheitert die IBAN, bleibt kein IBAN-loser Lieferant zurück.
// Legt den Kreditor samt erster IBAN in einer Transaktion an. @returns {number} id
export function legeKreditorAn(db, { name, kontoId, zahlungsart, betragSchwankt = false, normalizedIban }) {
  db.exec('BEGIN');
  try {
    const id = createKreditor(db, { name: name.trim(), kontoId: kontoId ? Number(kontoId) : null, zahlungsart, betragSchwankt });
    if (normalizedIban) createKreditorIban(db, { kreditorId: id, iban: normalizedIban, quelle: 'manuell' });
    db.exec('COMMIT');
    return id;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
