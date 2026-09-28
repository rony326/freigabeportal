import { createHash } from 'node:crypto';
import { normalizeIban, isValidIban } from './ibanUtils.js';

export function validateSpesenPayment(iban, owner) {
  const normalized = typeof iban === 'string' ? normalizeIban(iban) : '';
  const kontoinhaber = typeof owner === 'string' ? owner.trim() : '';
  if (!isValidIban(normalized) || !kontoinhaber || kontoinhaber.length > 200 || /[\x00-\x1f\x7f]/.test(kontoinhaber)) return null;
  const digits = (normalized.slice(4) + normalized.slice(0, 4)).replace(/[A-Z]/g, (letter) => String(letter.charCodeAt(0) - 55));
  let remainder = 0;
  for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97;
  return remainder === 1 ? { iban: normalized, kontoinhaber } : null;
}

// A stale-form fingerprint, not an authorization token; authorization is checked by the route.
export function paymentReviewFingerprint(job, konto, payment, personId) {
  return createHash('sha256').update(JSON.stringify({ job, konto, payment, personId })).digest('hex');
}
