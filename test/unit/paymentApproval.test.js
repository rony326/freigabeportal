import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSpesenPayment, paymentReviewFingerprint } from '../../src/services/paymentApproval.js';

test('payment validation normalizes a Swiss IBAN and trims the account holder', () => {
  assert.deepEqual(validateSpesenPayment('ch93 0076 2011 6238 5295 7', ' Person '), { iban: 'CH9300762011623852957', kontoinhaber: 'Person' });
});

test('payment validation rejects missing, malformed and checksum-invalid data', () => {
  for (const iban of [null, {}, 123, '', 'CH9400762011623852957', 'CH930076201162385295', 'DE89370400440532013000']) {
    assert.equal(validateSpesenPayment(iban, 'Person'), null);
  }
  for (const owner of [null, {}, 123, '', '  ', 'Name\nOther', 'x'.repeat(201)]) {
    assert.equal(validateSpesenPayment('CH9300762011623852957', owner), null);
  }
});

test('payment review is bound to job, account, payment and approving person', () => {
  const args = [{ id: 1, betrag: '12.00' }, { id: 2 }, { iban: 'CH9300762011623852957', kontoinhaber: 'Person' }, '3'];
  const original = paymentReviewFingerprint(...args);
  assert.equal(paymentReviewFingerprint(...args), original);
  for (let i = 0; i < args.length; i++) {
    const changed = [...args];
    changed[i] = i === 3 ? '4' : { ...args[i], changed: true };
    assert.notEqual(paymentReviewFingerprint(...changed), original);
  }
});

import { validateQrPayment, bestimmeZahlungsart, zahlungBestaetigungspflichtig } from '../../src/services/paymentApproval.js';

test('QR payment data needs a checksum-valid Swiss IBAN and a clean recipient; nothing else is guessed', () => {
  const basis = { qr_iban: 'ch93 0076 2011 6238 5295 7', qr_creditor_name: ' Muster AG ', qr_referenz: ' 210000000003139471430009017 ', qr_betrag: '12.00', qr_waehrung: 'CHF' };
  assert.deepEqual(validateQrPayment(basis), { iban: 'CH9300762011623852957', empfaenger: 'Muster AG', referenz: '210000000003139471430009017', betrag: '12.00', waehrung: 'CHF' });
  for (const kaputt of [{ qr_iban: 'CH9400762011623852957' }, { qr_iban: null }, { qr_creditor_name: '' }, { qr_creditor_name: 'A\nB' }, { qr_referenz: 'x'.repeat(36) }]) {
    assert.equal(validateQrPayment({ ...basis, ...kaputt }), null);
  }
});

test('payment kind follows the receipt type; split children inherit the whole invoice', () => {
  assert.equal(bestimmeZahlungsart({ quelle: 'spesen', qr_iban: 'x' }), 'spesen');
  assert.equal(bestimmeZahlungsart({ quelle: 'lieferant', typ: 'gutschrift', qr_iban: 'x' }), 'keine_zahlung');
  assert.equal(bestimmeZahlungsart({ quelle: 'scanner', qr_iban: 'x' }), 'qr_rechnung');
  assert.equal(bestimmeZahlungsart({ quelle: 'scanner', qr_iban: null }), 'ohne_zahlungsdaten');
  // A refund line inside an invoice still belongs to the invoice's single payment.
  assert.equal(bestimmeZahlungsart({ quelle: 'lieferant', typ: 'gutschrift', qr_iban: 'x' }, { typ: null, qr_iban: 'x' }), 'qr_rechnung');
  assert.equal(zahlungBestaetigungspflichtig({ art: 'ohne_zahlungsdaten', hinweise: [] }), false);
  assert.equal(zahlungBestaetigungspflichtig({ art: 'ohne_zahlungsdaten', hinweise: ['qr_ungueltig'] }), true);
  assert.equal(zahlungBestaetigungspflichtig({ art: 'keine_zahlung', hinweise: [] }), false);
});
