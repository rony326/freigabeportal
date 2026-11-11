// Gemeinsame Quelle für IBAN-Normalisierung und -Prüfung, damit QR-Parser, Betrugsprüfung,
// Zahlungsexport und Lieferanten-Stammdaten dasselbe unter einer IBAN verstehen (ein Auseinanderlaufen
// hat früher falsche IBAN-Abweichungs-Warnungen ausgelöst). Alle normalisieren mit `normalizeIban`.
// Geprüft wird in zwei Stufen: `isValidIban` + `ibanChecksumValid` streng nur CH (Zahlungsfreigabe
// für Spesen und QR-Rechnungen beim Export, paymentApproval.js), `isValidIbanInternational` mit
// Länderlängen für die Kreditor-Stammdaten (Admin-Formular, Lieferant anlegen aus der Kontierung).
const IBAN_PATTERN = /^CH\d{2}[0-9A-Z]{17}$/;

// Entfernt Leerzeichen und macht Grossbuchstaben (so sind IBANs überall vergleichbar).
export function normalizeIban(iban) {
  return (iban || '').replace(/\s/g, '').toUpperCase();
}

// Strenge Form-Prüfung nur für Schweizer/Liechtensteiner IBANs (CH + 2 Prüfziffern + 17 Zeichen).
export function isValidIban(iban) {
  return IBAN_PATTERN.test(iban);
}

// Prüfziffer nach ISO 13616 (Modulo 97).
export function ibanChecksumValid(iban) {
  const digits = (iban.slice(4) + iban.slice(0, 4)).replace(/[A-Z]/g, (letter) => String(letter.charCodeAt(0) - 55));
  let remainder = 0;
  for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97;
  return remainder === 1;
}

// IBAN-Gesamtlängen je Land (SWIFT-IBAN-Registry). Nur für die Kreditor-Stammdaten; QR, Spesen und
// Zahlungsexport bleiben bei der strengen CH-Prüfung `isValidIban`.
export const IBAN_LAENGEN = {
  AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22, BH: 22, BR: 29, BY: 28, CH: 21,
  CR: 22, CY: 28, CZ: 24, DE: 22, DK: 18, DO: 28, EE: 20, EG: 29, ES: 24, FI: 18, FO: 18, FR: 27,
  GB: 22, GE: 22, GI: 23, GL: 18, GR: 27, GT: 28, HR: 21, HU: 28, IE: 22, IL: 23, IQ: 23, IS: 26,
  IT: 27, JO: 30, KW: 30, KZ: 20, LB: 28, LC: 32, LI: 21, LT: 20, LU: 20, LV: 21, LY: 25, MC: 27,
  MD: 24, ME: 22, MK: 19, MR: 27, MT: 31, MU: 30, NL: 18, NO: 15, PK: 24, PL: 28, PS: 29, PT: 25,
  QA: 29, RO: 24, RS: 22, SA: 24, SC: 31, SE: 24, SI: 19, SK: 24, SM: 27, ST: 25, SV: 28, TL: 23,
  TN: 24, TR: 26, UA: 29, VA: 22, VG: 24, XK: 20,
};

// Länderlänge und Prüfziffer für beliebige Länder (Kreditor-Stammdaten).
export function isValidIbanInternational(iban) {
  const normalized = normalizeIban(typeof iban === 'string' ? iban : '');
  if (!/^[A-Z]{2}\d{2}[0-9A-Z]+$/.test(normalized)) return false;
  if (IBAN_LAENGEN[normalized.slice(0, 2)] !== normalized.length) return false;
  return ibanChecksumValid(normalized);
}

// Ländercode (erste zwei Zeichen).
export function ibanLand(iban) {
  return normalizeIban(iban).slice(0, 2);
}

// Gekürzte Anzeige "CH93 … 2957", damit Meldungen nie die ganze IBAN zeigen.
export function ibanKurz(iban) {
  const normalized = normalizeIban(iban);
  return `${normalized.slice(0, 4)} … ${normalized.slice(-4)}`;
}
