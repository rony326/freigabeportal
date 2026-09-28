import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findeBetraege, findeDaten, findeEndziffern, schlageTotalVor, analysiereText, berechneVorschlaege } from '../../src/services/kkTextAnalyse.js';

const TEXT = [
  'Visa Business **** 4242',
  "03.09.2026  SBB Bern          CHF   12.50",
  "05.09.26    Druckerei AG      CHF 1'234.50",
  '07.09.2026  Gutschrift Hotel  CHF   80.00 CR',
  '2026-09-08  Taxi              -15,00',
  'Total zu bezahlen                   1152.00',
].join('\n');

test('findeBetraege normalizes thousands separators, comma decimals and credit markers', () => {
  const werte = findeBetraege(TEXT).map((b) => b.betrag);
  assert.deepEqual(werte, ['12.50', '1234.50', '-80.00', '-15.00', '1152.00']);
  assert.equal(findeBetraege(TEXT)[1].zeile, 2);
});

test('findeBetraege ignores the card digits and dates', () => {
  assert.ok(!findeBetraege(TEXT).some((b) => b.betrag === '4242.00'));
});

test('findeDaten understands dd.mm.yyyy, dd.mm.yy and ISO', () => {
  assert.deepEqual(findeDaten(TEXT).map((d) => d.datum), ['2026-09-03', '2026-09-05', '2026-09-07', '2026-09-08']);
});

test('findeEndziffern finds masked card numbers in several styles', () => {
  assert.deepEqual([...findeEndziffern('Karte **** 4242')], ['4242']);
  assert.deepEqual([...findeEndziffern('XXXX XXXX XXXX 1234')], ['1234']);
  assert.deepEqual([...findeEndziffern('Kartennr. •••• 9876')], ['9876']);
  assert.deepEqual([...findeEndziffern('Konto 12345678')], []);
});

test('schlageTotalVor takes the last amount on the first Total/Saldo line', () => {
  assert.equal(schlageTotalVor(TEXT), '1152.00');
  assert.equal(schlageTotalVor('nichts hier'), null);
});

test('schlageTotalVor prefers CHF amount over other currencies', () => {
  assert.equal(schlageTotalVor('Total CHF 92.50 (approx EUR 100.00)'), '92.50');
});

test('berechneVorschlaege: amount match, amount+date match, and duplicates only as often as the amount appears', () => {
  const analyse = analysiereText(TEXT);
  const belege = [
    { id: 1, betrag: '12.50', kaufdatum: '2026-09-20' }, // amount only (date too far)
    { id: 2, betrag: '12.50', kaufdatum: '2026-09-02' }, // amount + date (±3 days) — wins the single occurrence
    { id: 3, betrag: '80.00', kaufdatum: '2026-09-07' }, // credit shown as CR, beleg positive: matched by absolute value
    { id: 4, betrag: '99.00', kaufdatum: '2026-09-07' }, // not on the statement
  ];
  const v = berechneVorschlaege(belege, analyse);
  assert.equal(v.get(2), 'betrag_datum');
  assert.equal(v.has(1), false);
  assert.equal(v.get(3), 'betrag_datum');
  assert.equal(v.has(4), false);
});

test('findeBetraege completes in under 200 ms on adversarial inputs', () => {
  const inputs = [
    '*'.repeat(20000),
    ('*X').repeat(10000) + '!',
    '1'.repeat(20000),
    ("1'").repeat(10000),
  ];

  for (const input of inputs) {
    const start = performance.now();
    findeBetraege(input);
    const elapsed = performance.now() - start;
    assert.ok(elapsed < 200, `findeBetraege took ${elapsed.toFixed(2)}ms on adversarial input`);
  }
});

test('findeDaten completes in under 200 ms on adversarial inputs', () => {
  const inputs = [
    '*'.repeat(20000),
    ('*X').repeat(10000) + '!',
    '1'.repeat(20000),
    ("1'").repeat(10000),
  ];

  for (const input of inputs) {
    const start = performance.now();
    findeDaten(input);
    const elapsed = performance.now() - start;
    assert.ok(elapsed < 200, `findeDaten took ${elapsed.toFixed(2)}ms on adversarial input`);
  }
});

test('findeEndziffern completes in under 200 ms on adversarial inputs', () => {
  const inputs = [
    '*'.repeat(20000),
    ('*X').repeat(10000) + '!',
    '1'.repeat(20000),
    ("1'").repeat(10000),
  ];

  for (const input of inputs) {
    const start = performance.now();
    findeEndziffern(input);
    const elapsed = performance.now() - start;
    assert.ok(elapsed < 200, `findeEndziffern took ${elapsed.toFixed(2)}ms on adversarial input`);
  }
});

test('schlageTotalVor completes in under 200 ms on adversarial inputs', () => {
  const inputs = [
    '*'.repeat(20000),
    ('*X').repeat(10000) + '!',
    '1'.repeat(20000),
    ("1'").repeat(10000),
  ];

  for (const input of inputs) {
    const start = performance.now();
    schlageTotalVor(input);
    const elapsed = performance.now() - start;
    assert.ok(elapsed < 200, `schlageTotalVor took ${elapsed.toFixed(2)}ms on adversarial input`);
  }
});
