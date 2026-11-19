import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Browser-Skript (kein ES-Modul): als Text laden und mit einem module-Objekt ausführen; die reine Prüflogik steht dann
// in module.exports, der Browser-Teil läuft nicht (er bricht vorher ab).
const modul = { exports: {} };
new Function('module', readFileSync(new URL('../../public/js/kontierung-pflicht.js', import.meta.url), 'utf8'))(modul);
const { offenePunkte } = modul.exports;

test('offenePunkte: leere Pflichtfelder und offene KI-Haken, je mit Feld-ID und Beschriftung', () => {
  const felder = [
    { id: 'kontoId', label: 'Konto', ungueltig: true, kiOffen: false },
    { id: 'rechnungsnummer', label: 'Rechnungsnummer', ungueltig: false, kiOffen: true },
    { id: 'betrag', label: 'Betrag', ungueltig: false, kiOffen: false },
  ];
  assert.deepEqual(offenePunkte(felder, true), {
    fehlend: [{ id: 'kontoId', label: 'Konto' }],
    ki: [{ id: 'rechnungsnummer', label: 'Rechnungsnummer' }],
  });
});

test('offenePunkte: ohne KI-Prüfung (z. B. Ablehnen) zählen nur leere Pflichtfelder', () => {
  const felder = [{ id: 'rechnungsnummer', label: 'Rechnungsnummer', ungueltig: false, kiOffen: true }];
  assert.deepEqual(offenePunkte(felder, false), { fehlend: [], ki: [] });
});

test('offenePunkte: ein leeres KI-Feld steht nur einmal, als fehlendes Pflichtfeld', () => {
  const felder = [{ id: 'zahlungsziel', label: 'Zahlungsziel', ungueltig: true, kiOffen: true }];
  assert.deepEqual(offenePunkte(felder, true), { fehlend: [{ id: 'zahlungsziel', label: 'Zahlungsziel' }], ki: [] });
});
