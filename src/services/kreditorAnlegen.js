// Gemeinsame Prüfung und Anlage von Kreditoren (Lieferanten) für das Admin-Formular und die Schnellanlage in der Kontierung.

import { getKontoById, kontoErlaubtFuerTyp } from '../db/kontenRepo.js';
import { createKreditor, ZAHLUNGSARTEN, brauchtIban } from '../db/kreditorenRepo.js';
import { createKreditorIban, findKreditorIbanByIban } from '../db/kreditorIbanRepo.js';
import { createZuweisungsregel, findZuweisungsregelByMuster } from '../db/zuweisungsregelnRepo.js';
import { normalizeIban, isValidIbanInternational } from './ibanUtils.js';
import { isValidAbsenderMuster, ABSENDER_MUSTER_FEHLER } from '../utils/absenderMuster.js';

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

export const ABSENDER_DOPPELT_FEHLER = 'Dieses Absender-Muster ist bereits einem Kreditor zugewiesen.';

/**
 * Gemeinsame Prüfung eines Absender-Musters für Zuweisungsregeln: Pflicht, gültige E-Mail-Adresse oder Domain,
 * noch keiner anderen Regel zugeordnet. Genutzt von POST /admin/kreditoren/regeln, /regeln/:id und beim Anlegen
 * eines Kreditors mit Absender.
 * @param {number|null} regelId beim Bearbeiten die eigene Regel (deren Muster gilt nicht als doppelt)
 * @returns {string[]} Fehlermeldungen (leer = gültig)
 */
export function pruefeAbsenderMuster(db, absenderMuster, { regelId = null } = {}) {
  if (!absenderMuster) return ['Absender-Muster ist ein Pflichtfeld.'];
  const errors = [];
  if (!isValidAbsenderMuster(absenderMuster)) errors.push(ABSENDER_MUSTER_FEHLER);
  const bestehend = findZuweisungsregelByMuster(db, absenderMuster);
  if (bestehend && bestehend.id !== regelId) errors.push(ABSENDER_DOPPELT_FEHLER);
  return errors;
}

// Kreditor, erste IBAN und optional erste Zuweisungsregel atomar: scheitert ein Teil, bleibt kein halber Lieferant zurück.
// Legt alles in einer Transaktion an (vorher mit pruefeNeuenKreditor/pruefeAbsenderMuster prüfen). @returns {number} id
export function legeKreditorAn(db, { name, kontoId, zahlungsart, betragSchwankt = false, normalizedIban, absenderMuster = null }) {
  db.exec('BEGIN');
  try {
    const id = createKreditor(db, { name: name.trim(), kontoId: kontoId ? Number(kontoId) : null, zahlungsart, betragSchwankt });
    if (normalizedIban) createKreditorIban(db, { kreditorId: id, iban: normalizedIban, quelle: 'manuell' });
    if (absenderMuster) createZuweisungsregel(db, { absenderMuster, kreditorId: id });
    db.exec('COMMIT');
    return id;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
