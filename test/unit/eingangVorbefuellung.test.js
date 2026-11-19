import { test } from 'node:test';
import assert from 'node:assert/strict';
import { leseEingangVorbefuellung } from '../../src/services/eingangVorbefuellung.js';
import { MAX_LAENGE } from '../../src/utils/eingabe.js';

test('übernimmt gültige Rechnungsnummer und Zahlungsziel (getrimmt)', () => {
  assert.deepEqual(leseEingangVorbefuellung({ rechnungsnummer: '  RE-2026-0042 ', zahlungsziel: ' 2026-12-31 ', betrag: ' 1234.50 ' }), {
    rechnungsnummer: 'RE-2026-0042',
    zahlungsziel: '2026-12-31',
    betragVorschlag: '1234.50',
  });
});

test('fehlende oder leere Felder ergeben null', () => {
  assert.deepEqual(leseEingangVorbefuellung({}), { rechnungsnummer: null, zahlungsziel: null, betragVorschlag: null });
  assert.deepEqual(leseEingangVorbefuellung(undefined), { rechnungsnummer: null, zahlungsziel: null, betragVorschlag: null });
  assert.deepEqual(leseEingangVorbefuellung({ rechnungsnummer: '   ', zahlungsziel: '' }), { rechnungsnummer: null, zahlungsziel: null, betragVorschlag: null });
});

test('verwirft ein Zahlungsziel in einem anderen Format oder mit unmöglichem Datum', () => {
  for (const wert of ['31.12.2026', '2026-1-5', '2026-12-31T00:00:00Z', '2026-13-01', '2026-02-30', '2026-02-31', 'morgen', '20261231']) {
    assert.equal(leseEingangVorbefuellung({ zahlungsziel: wert }).zahlungsziel, null, wert);
  }
  assert.equal(leseEingangVorbefuellung({ zahlungsziel: '2028-02-29' }).zahlungsziel, '2028-02-29');
});

test('verwirft eine zu lange Rechnungsnummer oder eine mit Steuerzeichen', () => {
  assert.equal(leseEingangVorbefuellung({ rechnungsnummer: 'X'.repeat(MAX_LAENGE.rechnungsnummer + 1) }).rechnungsnummer, null);
  assert.equal(leseEingangVorbefuellung({ rechnungsnummer: 'X'.repeat(MAX_LAENGE.rechnungsnummer) }).rechnungsnummer, 'X'.repeat(MAX_LAENGE.rechnungsnummer));
  assert.equal(leseEingangVorbefuellung({ rechnungsnummer: 'RE 1\nRE 2' }).rechnungsnummer, null);
});

test('verwirft Nicht-Text (mehrfach gesendetes Feld, Objekt) ohne Fehler', () => {
  assert.deepEqual(leseEingangVorbefuellung({ rechnungsnummer: ['a', 'b'], zahlungsziel: { x: 1 } }), { rechnungsnummer: null, zahlungsziel: null, betragVorschlag: null });
});

test('ein ungültiges Feld verwirft nur sich selbst, nicht das andere', () => {
  assert.deepEqual(leseEingangVorbefuellung({ rechnungsnummer: 'RE-1', zahlungsziel: 'kaputt' }), { rechnungsnummer: 'RE-1', zahlungsziel: null, betragVorschlag: null });
});

test('Betrag: Dezimalkomma wird zu Punkt, ungültige Beträge werden verworfen', () => {
  assert.equal(leseEingangVorbefuellung({ betrag: '1234,5' }).betragVorschlag, '1234.5');
  assert.equal(leseEingangVorbefuellung({ betrag: '80' }).betragVorschlag, '80');
  for (const wert of ["1'234.50", '1.234,50', '-50.00', 'CHF 12.00', '12.345', 'abc', '1e3']) {
    assert.equal(leseEingangVorbefuellung({ betrag: wert }).betragVorschlag, null, wert);
  }
});
