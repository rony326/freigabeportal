import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bauePortalGruppen, baueAdminGruppen, SYMBOLE } from '../../src/services/navigation.js';

const sprite = readFileSync(fileURLToPath(new URL('../../public/vendor/bootstrap-icons/symbole.svg', import.meta.url)), 'utf8');
const alle = [
  ...bauePortalGruppen({ pfad: '/', spesenModulAktiv: true, zeigeKreditkarteNav: true, offeneAufgaben: 0 }),
  ...baueAdminGruppen({ pfad: '/', adminNav: new Proxy({}, { get: () => true }) }),
];
const punkte = alle.flatMap((g) => g.punkte);

test('jedes Navigationssymbol und jeder Eintrag in SYMBOLE steht im Sprite', () => {
  assert.ok(punkte.length > 20);
  for (const name of new Set([...punkte.map((p) => p.symbol), ...SYMBOLE])) {
    assert.ok(sprite.includes(`<symbol id="${name}" `), `Symbol fehlt im Sprite: ${name}`);
  }
});

test('jedes Navigationssymbol ist in SYMBOLE aufgeführt', () => {
  for (const p of punkte) assert.ok(SYMBOLE.includes(p.symbol), `nicht in SYMBOLE: ${p.symbol} (${p.label})`);
});

test('Navigationssymbole sind untereinander eindeutig', () => {
  const namen = punkte.map((p) => p.symbol);
  assert.equal(new Set(namen).size, namen.length);
});
