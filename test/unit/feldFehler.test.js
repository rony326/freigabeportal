import { test } from 'node:test';
import assert from 'node:assert/strict';
import { neueFehler, feldFehlerAttr } from '../../src/utils/feldFehler.js';

test('neueFehler sammelt Texte und führt pro Feld den ersten Text', () => {
  const f = neueFehler();
  f.add('betrag', 'A');
  f.add('betrag', 'B');
  f.add(null, 'C');
  assert.deepEqual(f.liste, ['A', 'B', 'C']);
  assert.deepEqual(f.proFeld, { betrag: 'A' });
});

test('feldFehlerAttr liefert ARIA-Attribute nur für Felder mit Fehler', () => {
  assert.equal(feldFehlerAttr({ betrag: 'A' }, 'betrag'), ' aria-invalid="true" aria-describedby="betrag-fehler"');
  assert.equal(feldFehlerAttr({ betrag: 'A' }, 'absender'), '');
  assert.equal(feldFehlerAttr(undefined, 'absender'), '');
});
