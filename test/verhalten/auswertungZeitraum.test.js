// Auswertung: Zeitraum-Auswahl und Von/Bis-Felder gehören zusammen.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { starteBrowser } from './helfer.js';

let b;
before(async () => { b = await starteBrowser(); });
after(async () => { await b.stop(); });

test('Datum ändern stellt den Zeitraum auf «Eigener Zeitraum»', async () => {
  const page = await b.neueSeite('/auswertung');
  assert.equal(await page.inputValue('#zeitraum'), 'jahr');
  await page.fill('#von', '2025-03-01');
  assert.equal(await page.inputValue('#zeitraum'), 'eigen');
  await page.close();
});

test('Voreinstellung wählen füllt Von/Bis passend aus', async () => {
  const page = await b.neueSeite('/auswertung');
  const jahr = new Date().getFullYear();
  await page.selectOption('#zeitraum', 'vorjahr');
  assert.equal(await page.inputValue('#von'), `${jahr - 1}-01-01`);
  assert.equal(await page.inputValue('#bis'), `${jahr - 1}-12-31`);
  await page.close();
});
