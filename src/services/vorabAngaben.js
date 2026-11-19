// Was Pool, Aufgabenlisten und Admin-Vorgänge zu einem Vorgang schon vor der Kontierung anzeigen: Lieferant, Betrag und
// Rechnungsnummer, je mit der Angabe, ob der Wert noch ungeprüft ist (automatisch erkannt, von niemandem bestätigt).
// Ungeprüfte Werte erscheinen farblich markiert (views/_vorab_wert.ejs), damit sie bei der Kontierung kontrolliert werden.
//
// Ungeprüft sind nur Werte, die n8n beim Eingang mitgeschickt hat (z. B. KI-gelesen): Rechnungsnummer und Upload-Betrag vor
// der Kontierung. Verlässlich und daher nicht markiert: kontierte Werte, der Lieferant aus einer Zuweisungsregel, der QR-Betrag
// und der Lieferant zur QR-IBAN (IBAN maschinenlesbar aus dem QR-Code, Zuordnung von einem Admin hinterlegt; der eigentliche
// IBAN-Abgleich läuft erst beim Speichern der Kontierung). Die Kontierung verlangt für die KI-Werte eine Bestätigung
// (services/kiBestaetigung.js).
// Reihenfolge je Feld:
//   Lieferant:       jobs.lieferant (Regel/kontiert) → Lieferant, bei dem die QR-IBAN hinterlegt ist
//   Betrag:          jobs.betrag (kontiert) → QR-Betrag → Betrag aus dem n8n-Upload (betrag_vorschlag, ungeprüft)
//   Rechnungsnummer: jobs.rechnungsnummer; vor der Kontierung stammt sie aus dem n8n-Upload (ungeprüft)

import { findKreditorIbanByIban } from '../db/kreditorIbanRepo.js';
import { getKreditorById } from '../db/kreditorenRepo.js';

const LEER = Object.freeze({ wert: null, ungeprueft: false });

function lieferantZurQrIban(db, job) {
  if (!job.qr_iban) return null;
  const treffer = findKreditorIbanByIban(db, job.qr_iban);
  const kreditor = treffer ? getKreditorById(db, treffer.kreditor_id) : null;
  return kreditor && kreditor.aktiv ? kreditor.name : null;
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} job Zeile aus `jobs`
 * @returns {{lieferant: {wert: string|null, ungeprueft: boolean}, betrag: {wert: string|null, ungeprueft: boolean},
 *   rechnungsnummer: {wert: string|null, ungeprueft: boolean}}}
 */
export function vorabAngaben(db, job) {
  const kontiert = job.betrag != null && job.betrag !== '';

  let lieferant = LEER;
  if (job.lieferant) lieferant = { wert: job.lieferant, ungeprueft: false };
  else if (!kontiert) {
    const name = lieferantZurQrIban(db, job);
    if (name) lieferant = { wert: name, ungeprueft: false };
  }

  let betrag = LEER;
  if (kontiert) betrag = { wert: job.betrag, ungeprueft: false };
  else if (job.qr_betrag) betrag = { wert: job.qr_betrag, ungeprueft: false };
  else if (job.betrag_vorschlag) betrag = { wert: job.betrag_vorschlag, ungeprueft: true };

  const rechnungsnummer = job.rechnungsnummer ? { wert: job.rechnungsnummer, ungeprueft: !kontiert } : LEER;

  return { lieferant, betrag, rechnungsnummer };
}
