import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQrBillPayload } from '../../src/services/qrBill.js';

// 31 lines, in SPC payload order: header, version, coding type, IBAN, creditor address block
// (7 lines), ultimate-creditor block (7 lines, reserved/blank), amount, currency, ultimate-debtor
// block (7 lines), reference type, reference, unstructured message, trailer.
function buildSpcPayload(overrides = {}) {
  const lines = [
    'SPC', '0200', '1',
    overrides.iban ?? 'CH4431999123000889012',
    'S', overrides.creditorName ?? 'Muster AG', 'Musterstrasse', '7', '1234', 'Musterstadt', 'CH',
    '', '', '', '', '', '', '',
    overrides.betrag ?? '1949.75', overrides.waehrung ?? 'CHF',
    '', '', '', '', '', '', '',
    overrides.referenzTyp ?? 'QRR', overrides.referenz ?? '210000000003139471430009017',
    'Vielen Dank für Ihren Einkauf', 'EPD',
  ];
  return lines.join('\r\n');
}

test('parses a full QRR-referenced payload', () => {
  const result = parseQrBillPayload(buildSpcPayload());
  assert.deepEqual(result, {
    iban: 'CH4431999123000889012',
    creditorName: 'Muster AG',
    betrag: '1949.75',
    waehrung: 'CHF',
    referenz: '210000000003139471430009017',
  });
});

test('parses a SCOR-referenced payload', () => {
  const result = parseQrBillPayload(buildSpcPayload({ referenzTyp: 'SCOR', referenz: 'RF18539007547034' }));
  assert.equal(result.referenz, 'RF18539007547034');
});

test('parses a NON-referenced payload with referenz set to null', () => {
  const result = parseQrBillPayload(buildSpcPayload({ referenzTyp: 'NON', referenz: '' }));
  assert.equal(result.referenz, null);
});

test('parses a payload with no amount (betrag is null)', () => {
  const result = parseQrBillPayload(buildSpcPayload({ betrag: '' }));
  assert.equal(result.betrag, null);
});

test('returns null for text that is not a QR-bill payload at all', () => {
  assert.equal(parseQrBillPayload('irgendein anderer QR-Code-Inhalt'), null);
});

test('returns null for empty or missing text', () => {
  assert.equal(parseQrBillPayload(''), null);
  assert.equal(parseQrBillPayload(null), null);
});

test('returns null when the IBAN line is empty', () => {
  assert.equal(parseQrBillPayload(buildSpcPayload({ iban: '' })), null);
});
