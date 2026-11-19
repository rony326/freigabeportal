// Optionale Vorbefüllung beim Rechnungseingang (POST /api/n8n/jobs): Rechnungsnummer, Zahlungsziel und Betrag, die n8n z. B. von
// einem KI-Modell aus dem PDF lesen lässt. Die Werte sind nur ein Vorschlag für die Kontierung (die Person sieht sie im
// Formular und korrigiert sie bei Bedarf). Deshalb wird ein ungültiger Wert still verworfen (null) statt den Upload mit
// 400 abzulehnen – eine Rechnung darf nie an einem schlecht gelesenen Wert scheitern.

import { MAX_LAENGE } from '../utils/eingabe.js';

// Gleiches Format wie das Kontierungsformular (ZAHLUNGSZIEL_PATTERN in routes/kontierung.js, <input type="date">).
const ZAHLUNGSZIEL_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
// eslint-disable-next-line no-control-regex
// Gleiches Format wie der Betrag im Kontierungsformular (BETRAG_PATTERN in routes/kontierung.js): positiv, höchstens zwei
// Nachkommastellen, Punkt oder Komma. Tausendertrennzeichen (1'234.50) sind bewusst nicht erlaubt – mehrdeutig.
const BETRAG_PATTERN = /^\d+([.,]\d{1,2})?$/;
const STEUERZEICHEN = /[\u0000-\u001f\u007f]/;

function text(wert) {
  if (typeof wert !== 'string') return null;
  const t = wert.trim();
  return t === '' ? null : t;
}

// Kalendertag muss existieren: new Date('2026-02-31') rollt in V8 still auf den 3. März – deshalb Rückvergleich.
function gueltigesDatum(wert) {
  if (!ZAHLUNGSZIEL_PATTERN.test(wert)) return false;
  const datum = new Date(`${wert}T00:00:00Z`);
  return !Number.isNaN(datum.getTime()) && datum.toISOString().slice(0, 10) === wert;
}

/**
 * @param {object|undefined} body req.body des Multipart-Uploads
 * @returns {{rechnungsnummer: string|null, zahlungsziel: string|null, betragVorschlag: string|null}} gültige Werte, sonst null je
 *   Feld; der Betrag mit Punkt als Dezimaltrennzeichen (wie beim Speichern der Kontierung)
 */
export function leseEingangVorbefuellung(body) {
  const rechnungsnummer = text(body?.rechnungsnummer);
  const zahlungsziel = text(body?.zahlungsziel);
  const betrag = text(body?.betrag);
  return {
    rechnungsnummer:
      rechnungsnummer && rechnungsnummer.length <= MAX_LAENGE.rechnungsnummer && !STEUERZEICHEN.test(rechnungsnummer)
        ? rechnungsnummer
        : null,
    zahlungsziel: zahlungsziel && gueltigesDatum(zahlungsziel) ? zahlungsziel : null,
    betragVorschlag: betrag && betrag.length <= MAX_LAENGE.betrag && BETRAG_PATTERN.test(betrag) ? betrag.replace(',', '.') : null,
  };
}
