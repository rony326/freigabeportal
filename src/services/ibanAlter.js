// Hinweis in Freigabe 2: Die IBAN, an die gezahlt würde, wurde erst kürzlich beim Lieferanten hinterlegt.
// Typisches Betrugsmuster: Jemand trägt eine fremde IBAN ein und lässt eine Rechnung dazu durchlaufen. Der Hinweis blockiert
// nichts, er verlangt nur genaues Hinsehen (siehe docs/qr-bill-und-betrugserkennung.md). Das Alter stammt aus
// kreditor_ibans.erstellt_am, der Erfasser aus erstellt_von (bei älteren Einträgen unbekannt).
import { listKreditorIbansByKreditor } from '../db/kreditorIbanRepo.js';
import { getPersonById } from '../db/personenRepo.js';
import { normalizeIban, ibanKurz } from './ibanUtils.js';
import { formatZeitpunkt } from './auditLog.js';

// Eine IBAN gilt als neu, solange sie jünger als so viele Tage ist (genau 14 Tage alt = nicht mehr neu).
export const IBAN_NEU_TAGE = 14;

function erfasserName(db, personId) {
  if (!personId) return 'unbekannt';
  if (personId === 'system') return 'System';
  const person = getPersonById(db, personId);
  return person ? `${person.vorname} ${person.nachname}` : 'unbekannt';
}

/**
 * Sucht die junge IBAN zu einer Rechnung. Mit QR-IBAN zählt nur der passende Eintrag des Lieferanten; ohne QR-IBAN (manuelle
 * Zahlung) die jüngste junge IBAN des Lieferanten.
 * @param {object} job Vorgang (kreditor_id, qr_iban, quelle)
 * @returns {null|{iban: string, datum: string, erfasstVon: string, fuerRechnung: boolean}} null, wenn kein Hinweis nötig ist
 */
export function ibanAlterHinweis(db, job, { jetzt = Date.now() } = {}) {
  if (!job || job.quelle === 'spesen' || !job.kreditor_id) return null;
  const grenze = IBAN_NEU_TAGE * 24 * 3600 * 1000;
  const jung = (zeile) => jetzt - Date.parse(zeile.erstellt_am) < grenze;
  const zeilen = listKreditorIbansByKreditor(db, job.kreditor_id);
  const qr = job.qr_iban ? normalizeIban(job.qr_iban) : '';
  const treffer = qr
    ? zeilen.filter((z) => normalizeIban(z.iban) === qr && jung(z))
    : zeilen.filter(jung).sort((a, b) => Date.parse(b.erstellt_am) - Date.parse(a.erstellt_am));
  const zeile = treffer[0];
  if (!zeile) return null;
  return {
    iban: ibanKurz(zeile.iban),
    datum: formatZeitpunkt(zeile.erstellt_am, true),
    erfasstVon: erfasserName(db, zeile.erstellt_von),
    fuerRechnung: Boolean(qr),
  };
}
