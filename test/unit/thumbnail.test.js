import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument as PdfLibDocument } from 'pdf-lib';
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

test('clamps rasterization for a degenerate narrow/tall page instead of an unbounded pixmap', async () => {
  // A page like [50, 5000] is legal PDF geometry but, without a pixel-count clamp,
  // `scale = THUMBNAIL_WIDTH_PX / width` alone would blow the rendered height up to match the
  // declared width-to-height ratio — an unbounded-memory DoS reachable from any untrusted PDF
  // ingested via POST /n8n/jobs (mirrors the same fix already in qrBillScan.js). This asserts the
  // clamp keeps rendering fast and still produces a valid PNG.
  const doc = await PdfLibDocument.create();
  doc.addPage([50, 5000]);
  const pdf = Buffer.from(await doc.save());

  const start = Date.now();
  const png = renderFirstPageThumbnail(pdf);
  const elapsedMs = Date.now() - start;

  assert.equal(png.subarray(0, 4).toString('hex'), PNG_HEADER);
  assert.ok(elapsedMs < 2000, `expected renderFirstPageThumbnail to complete quickly, took ${elapsedMs}ms`);
});
