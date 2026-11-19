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

// Symbole, die Views direkt einbinden (include('_symbol', { name: '…' })), müssen ebenfalls im Sprite stehen – sonst
// rendert der Browser ein leeres Bild (so geschehen beim Bestätigungs-Haken der KI-Werte, 1.4.7).
test('jedes in einer View eingebundene Symbol steht im Sprite', async () => {
  const { readdirSync } = await import('node:fs');
  const { join } = await import('node:path');
  const wurzel = fileURLToPath(new URL('../../views', import.meta.url));
  const dateien = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? dateien(join(dir, e.name)) : e.name.endsWith('.ejs') ? [join(dir, e.name)] : []));
  const namen = new Set();
  for (const datei of dateien(wurzel)) {
    for (const m of readFileSync(datei, 'utf8').matchAll(/include\(\s*["'](?:\.\.\/)*_symbol["']\s*,\s*\{\s*name:\s*["']([\w-]+)["']/g)) namen.add(m[1]);
  }
  assert.ok(namen.size > 3, 'Symbol-Einbindungen in Views gefunden');
  for (const name of namen) assert.ok(sprite.includes(`<symbol id="${name}" `), `Symbol fehlt im Sprite: ${name} (in SYMBOLE aufnehmen, dann node scripts/baueSymbole.js)`);
});
