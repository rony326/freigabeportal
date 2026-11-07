import { test } from 'node:test';
import assert from 'node:assert/strict';
import { leseTabelle, ordneZu, erkenneKopfzeile } from '../../src/services/budgetImport.js';
import { baueXlsx } from '../helpers/xlsxFixture.js';

const KONTEN = [{ id: 1, kontonummer: '4000' }, { id: 2, kontonummer: '4100' }, { id: 3, kontonummer: '4200' }];

test('CSV mit Semikolon und BOM', async () => {
  const zeilen = await leseTabelle(Buffer.from('﻿Konto;Budget\n4000;"12\'000.50"\r\n4100;500\n', 'utf8'), 'budget.csv');
  assert.deepEqual(zeilen, [['Konto', 'Budget'], ['4000', "12'000.50"], ['4100', '500']]);
});

test('CSV mit Komma und Anführungszeichen', async () => {
  const zeilen = await leseTabelle(Buffer.from('Konto,Budget\n4000,"12 000,50"\n', 'utf8'), 'Budget.CSV');
  assert.deepEqual(zeilen, [['Konto', 'Budget'], ['4000', '12 000,50']]);
});

test('XLSX-Datei: erstes Blatt, Zahlen werden zu Text', async () => {
  const zeilen = await leseTabelle(baueXlsx([['Kontonummer', 'Betrag'], [4000, 1500], ['4100', '2\'000']]), 'budget.xlsx');
  assert.deepEqual(zeilen, [['Kontonummer', 'Betrag'], ['4000', '1500'], ['4100', "2'000"]]);
});

test('falsche Endung oder kaputte XLSX → verständlicher Fehler', async () => {
  await assert.rejects(() => leseTabelle(Buffer.from('x'), 'budget.xls'), /CSV- oder Excel-Datei \(\.xlsx\)/);
  await assert.rejects(() => leseTabelle(Buffer.from('kein zip'), 'budget.xlsx'), /konnte nicht gelesen werden/);
});

test('Kopfzeile erkannt, wenn die Betragszelle der ersten Zeile keine Zahl ist', () => {
  assert.equal(erkenneKopfzeile([['Konto', 'Budget'], ['4000', '1']], 1), true);
  assert.equal(erkenneKopfzeile([['4000', '1'], ['4100', '2']], 1), false);
  assert.equal(erkenneKopfzeile([], 1), false);
});

test('ordneZu: gültige Zeilen, unbekannte Kontonummer, leere Zeile, ungültiger Betrag, doppelt', () => {
  const zeilen = [['Konto', 'Budget'], ['4000', "12'000.–"], ['', ''], ['9999', '10'], ['4100', 'viel'], ['4200', '12 000,50'], ['4000', '5']];
  const bisher = new Map([[1, 9000]]);
  const r = ordneZu(zeilen, { spalteKonto: 0, spalteBetrag: 1, hatKopfzeile: true }, KONTEN, bisher);
  assert.deepEqual(r.gueltig, [
    { kontoId: 1, kontonummer: '4000', betrag: 12000, bisher: 9000 },
    { kontoId: 3, kontonummer: '4200', betrag: 12000.5, bisher: null },
  ]);
  assert.deepEqual(r.fehler.map((f) => f.zeile), [3, 4, 5, 7]);
  assert.match(r.fehler[0].grund, /leer/i);
  assert.match(r.fehler[1].grund, /9999/);
  assert.match(r.fehler[2].grund, /Betrag/);
  assert.match(r.fehler[3].grund, /mehrfach/);
});

test('ordneZu: andere Spaltenzuordnung, ohne Kopfzeile', () => {
  const r = ordneZu([['Jugend', '300', '4000']], { spalteKonto: 2, spalteBetrag: 1, hatKopfzeile: false }, KONTEN, new Map());
  assert.deepEqual(r.gueltig, [{ kontoId: 1, kontonummer: '4000', betrag: 300, bisher: null }]);
});
