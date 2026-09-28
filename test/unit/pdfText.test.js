import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extrahierePdfText } from '../../src/services/pdfText.js';
import { buildPdfFixture } from '../helpers/pdfFixture.js';

test('extrahierePdfText returns the text of all pages', async () => {
  const pdf = await buildPdfFixture(['Karte **** 4242', 'Total 12.50']);
  const text = extrahierePdfText(pdf);
  assert.match(text, /4242/);
  assert.match(text, /Total 12\.50/);
});

test('extrahierePdfText throws on garbage', () => {
  assert.throws(() => extrahierePdfText(Buffer.from('kein pdf')));
});
