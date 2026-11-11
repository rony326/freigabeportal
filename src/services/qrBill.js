// Parser für die Zahlungsdaten im QR-Code einer Schweizer QR-Rechnung (docs/qr-bill-und-betrugserkennung.md).

import { normalizeIban } from './ibanUtils.js';

// Zeilenreihenfolge nach dem Schweizer "Style Guide QR-Rechnung" (SIX/SPC v2.x) für die im QR-Code einer Schweizer QR-Rechnung
// eingebettete Nutzlast. Benannt sind nur die Zeilen, die dieser Parser tatsächlich liest; alles andere (detaillierte
// Zahlungsempfänger-/Zahlungspflichtigen-Adresszeilen, der noch reservierte Block "Ultimate Creditor") wird übersprungen. Gegen eine
// echte, mit der Bibliothek `swissqrbill` erzeugte Nutzlast in qrBillScan.test.js gegengeprüft — widerspricht dieser Test der
// Feldextraktion hier, sind diese Indizes falsch.
const LINE = {
  HEADER: 0,
  IBAN: 3,
  CREDITOR_NAME: 5,
  AMOUNT: 18,
  CURRENCY: 19,
  REFERENCE_TYPE: 27,
  REFERENCE: 28,
};
const MIN_LINES = 31;
const EXPECTED_HEADER = 'SPC';

/**
 * @param {string} text Text des QR-Codes (Zeilen, beginnend mit "SPC")
 * @returns {{iban: string, creditorName: string|null, betrag: string|null, waehrung: string|null, referenz: string|null}|null}
 *   null, wenn es keine gültige Nutzlast ist (Kopf, Zeilenzahl, IBAN)
 */
export function parseQrBillPayload(text) {
  if (!text) return null;
  const zeilen = text.split(/\r\n|\r|\n/);
  if (zeilen.length < MIN_LINES) return null;
  if (zeilen[LINE.HEADER].trim() !== EXPECTED_HEADER) return null;

  // normalizeIban entfernt auch Leerzeichen mitten in der IBAN, nicht nur am Rand — nicht normkonforme, aber real vorkommende
  // QR-Rechnungs-Generatoren geben Leerzeichen als Gruppierung in der IBAN-Zeile aus, und blieben sie stehen, wäre die IBAN nie
  // gleich den über die Admin-Route gespeicherten, leerzeichenlosen IBANs und löste bei einer legitimen Rechnung einen falschen
  // IBAN-Abweichungs-Alarm aus.
  const iban = normalizeIban(zeilen[LINE.IBAN]);
  if (!iban) return null;

  const referenzTyp = zeilen[LINE.REFERENCE_TYPE].trim();
  const referenz = zeilen[LINE.REFERENCE].trim();
  const betrag = zeilen[LINE.AMOUNT].trim();
  const waehrung = zeilen[LINE.CURRENCY].trim();
  const creditorName = zeilen[LINE.CREDITOR_NAME].trim();

  return {
    iban,
    creditorName: creditorName || null,
    betrag: betrag || null,
    waehrung: waehrung || null,
    referenz: referenzTyp !== 'NON' && referenz ? referenz : null,
  };
}
