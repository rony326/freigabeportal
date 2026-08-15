import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderFirstPageThumbnail } from '../../src/services/thumbnail.js';
import { buildPdfFixture } from '../helpers/pdfFixture.js';

const PNG_HEADER = '89504e47';

test('renders a PNG thumbnail of page 0 when the Visum page is last', async () => {
  const pdf = await buildPdfFixture(['Rechnung Seite 1', 'Rechnung Seite 2', 'Visum / Rechnungsfreigabe']);
  const png = renderFirstPageThumbnail(pdf, 'letzte');
  assert.equal(png.subarray(0, 4).toString('hex'), PNG_HEADER);
});

test('renders a PNG thumbnail of page 1 when the Visum page is first', async () => {
  const pdf = await buildPdfFixture(['Visum / Rechnungsfreigabe', 'Rechnung Seite 1', 'Rechnung Seite 2']);
  const png = renderFirstPageThumbnail(pdf, 'erste');
  assert.equal(png.subarray(0, 4).toString('hex'), PNG_HEADER);
});

test('falls back to page 0 when visumSeitePosition is "erste" but the PDF has only one page', async () => {
  const pdf = await buildPdfFixture(['Nur eine Seite']);
  const png = renderFirstPageThumbnail(pdf, 'erste');
  assert.equal(png.subarray(0, 4).toString('hex'), PNG_HEADER);
});

test('throws a defined Error for a corrupt PDF, does not crash', () => {
  const corrupt = Buffer.from('%PDF-1.4\n%not-a-real-pdf-body\n');
  assert.throws(() => renderFirstPageThumbnail(corrupt, 'letzte'), Error);
});
