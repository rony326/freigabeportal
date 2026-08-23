// Single shared source of truth for IBAN normalization/validation — used by the QR-bill payload
// parser, the admin Lieferanten-IBAN form, and the Kontierung "IBAN merken" opt-in save, so all
// three agree on what counts as a well-formed Swiss IBAN and none of them can drift out of sync
// with the others (a drift here previously caused false-positive IBAN-mismatch fraud alerts).
const IBAN_PATTERN = /^CH\d{2}[0-9A-Z]{17}$/;

export function normalizeIban(iban) {
  return (iban || '').replace(/\s/g, '').toUpperCase();
}

export function isValidIban(iban) {
  return IBAN_PATTERN.test(iban);
}
