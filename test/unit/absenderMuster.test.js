import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidAbsenderMuster } from '../../src/utils/absenderMuster.js';

test('isValidAbsenderMuster accepts domains and e-mail addresses', () => {
  for (const muster of ['viseca.ch', 'abrechnung@bank.ch', 'mail.lieferant.ch', 'my-bank.co.uk', 'Rechnung@Lieferant.CH']) {
    assert.equal(isValidAbsenderMuster(muster), true, muster);
  }
});

test('isValidAbsenderMuster rejects bare TLDs, malformed domains and addresses', () => {
  for (const muster of ['ch', 'com', '-bank.ch', 'bank-.ch', 'bank..ch', '.ch', 'bank.ch.', 'viseca ch', '@bank.ch', 'abrechnung@', 'abrechnung@bank', 'a b@bank.ch', 'a@b@bank.ch', '*.bank.ch']) {
    assert.equal(isValidAbsenderMuster(muster), false, muster);
  }
});

test('isValidAbsenderMuster bleibt bei sehr langer Eingabe schnell', () => {
  const lang = `${'a'.repeat(100_000)}@${'b.'.repeat(10)}`;
  const t0 = performance.now();
  assert.equal(isValidAbsenderMuster(lang), false);
  assert.equal(isValidAbsenderMuster('a'.repeat(100_000)), false);
  assert.ok(performance.now() - t0 < 100);
});
