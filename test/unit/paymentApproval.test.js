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
