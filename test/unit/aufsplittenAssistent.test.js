import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { verteileVersandkosten } from '../../src/services/aufsplitten.js';

// Browser-Skript (kein ES-Modul): als Text laden und mit einem module-Objekt ausführen; die reine Rechenlogik steht dann
// in module.exports, der Browser-Teil läuft nicht (er bricht vorher ab).
const modul = { exports: {} };
new Function('module', readFileSync(new URL('../../public/js/aufsplitten-assistent.js', import.meta.url), 'utf8'))(modul);
const { rappen, verteile, stand } = modul.exports;

test('rappen: Betrag mit Punkt oder Komma in ganzen Rappen, gleiches Format wie der Server', () => {
  assert.equal(rappen('10,5'), 1050);
  assert.equal(rappen(' 210.00 '), 21000);
  assert.equal(rappen('0.29'), 29);
  assert.equal(rappen('7'), 700);
  for (const ungueltig of ['', '  ', 'abc', '-1', '1.234', '1.', '1e3', "1'000.00"]) assert.equal(rappen(ungueltig), null, ungueltig);
});

test('verteile: Rest an den letzten Teil, genau wie verteileVersandkosten auf dem Server', () => {
  assert.deepEqual(verteile(1000, 3), [333, 333, 334]);
  assert.deepEqual(verteile(1000, 0), []);
  for (const [versand, anzahl] of [[0, 2], [1, 3], [950, 2], [999, 7]]) {
    assert.deepEqual(verteile(versand, anzahl), verteileVersandkosten(versand, anzahl));
  }
});

test('stand: Ziel = Gesamtbetrag minus Versandkosten, leere und ungültige Teile zählen nicht', () => {
  assert.deepEqual(stand('210.00', '10.00', ['120.00', '']), { ziel: 20000, verteilt: 12000, offen: 8000 });
  assert.deepEqual(stand('200', '', ['150', '60,00', 'abc']), { ziel: 20000, verteilt: 21000, offen: -1000 });
  assert.deepEqual(stand('0.30', '', ['0.10', '0.20']), { ziel: 30, verteilt: 30, offen: 0 });
  assert.equal(stand('', '', []), null);
  assert.equal(stand('abc', '10.00', ['1']), null);
});
