import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderFirstPageThumbnail } from '../../src/services/thumbnail.js';
import { buildPdfFixture } from '../helpers/pdfFixture.js';

const PNG_HEADER = '89504e47';

test('renders a PNG thumbnail of page 0', async () => {
  const pdf = await buildPdfFixture(['Rechnung Seite 1', 'Rechnung Seite 2']);
  const png = renderFirstPageThumbnail(pdf);
  assert.equal(png.subarray(0, 4).toString('hex'), PNG_HEADER);
});

test('renders a PNG thumbnail of page 0 for a single-page PDF', async () => {
  const pdf = await buildPdfFixture(['Nur eine Seite']);
  const png = renderFirstPageThumbnail(pdf);
  assert.equal(png.subarray(0, 4).toString('hex'), PNG_HEADER);
});

test('throws a defined Error for a corrupt PDF, does not crash', () => {
  const corrupt = Buffer.from('%PDF-1.4\n%not-a-real-pdf-body\n');
  assert.throws(() => renderFirstPageThumbnail(corrupt), Error);
});
