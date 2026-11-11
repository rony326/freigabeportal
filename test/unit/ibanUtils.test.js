import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeIban, isValidIban, isValidIbanInternational, ibanKurz, ibanLand, ibanChecksumValid } from '../../src/services/ibanUtils.js';

test('isValidIbanInternational akzeptiert gültige IBANs', () => {
  assert.equal(isValidIbanInternational('DE89 3704 0044 0532 0130 00'.replace(/\s/g, '')), true);
  assert.equal(isValidIbanInternational('de89 3704 0044 0532 0130 00'), true);
  assert.equal(isValidIbanInternational('CH9300762011623852957'), true);
});

test('isValidIbanInternational lehnt falsche Prüfziffer, Länge und Land ab', () => {
  assert.equal(isValidIbanInternational('CH9300762011623852958'), false);
  assert.equal(isValidIbanInternational('DE8937040044053201300'), false);
  assert.equal(isValidIbanInternational('XX00123'), false);
  assert.equal(isValidIbanInternational(''), false);
  assert.equal(isValidIbanInternational(null), false);
});

test('isValidIban bleibt streng auf CH', () => {
  assert.equal(isValidIban('DE89370400440532013000'), false);
  assert.equal(isValidIban('CH9300762011623852957'), true);
});

test('ibanChecksumValid prüft Mod-97', () => {
  assert.equal(ibanChecksumValid('CH9300762011623852957'), true);
  assert.equal(ibanChecksumValid('CH9300762011623852958'), false);
});

test('ibanKurz und ibanLand', () => {
  assert.equal(ibanKurz('CH9300762011623852957'), 'CH93 … 2957');
  assert.equal(ibanKurz('ch93 0076 2011 6238 5295 7'), 'CH93 … 2957');
  assert.equal(ibanLand('de89370400440532013000'), 'DE');
});

test('normalizeIban', () => {
  assert.equal(normalizeIban(' ch93 0076 '), 'CH930076');
});
