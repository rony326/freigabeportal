import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PageSizes } from 'pdf-lib';
import { mergeBelegInPdf, detectBelegMimetype, countBelegSeiten, buildBelegPdf } from '../../src/services/belegAnhaengen.js';
import { buildPdfFixture } from '../helpers/pdfFixture.js';
import { PNG_1X1, JPEG_1X1, buildSolidPng } from '../helpers/imageFixture.js';

const [A4_HOCH_BREITE, A4_HOCH_HOEHE] = PageSizes.A4;

test('merging a PDF Beleg appends its pages after the original pages', async () => {
  const original = await buildPdfFixture(['Original Seite 1', 'Original Seite 2']);
  const beleg = await buildPdfFixture(['Beleg Seite 1']);

  const merged = await mergeBelegInPdf(original, beleg, 'application/pdf');

  const reloaded = await PDFDocument.load(merged);
  assert.equal(reloaded.getPageCount(), 3, 'original 2 pages + 1 appended Beleg page');
});

test('merging a PNG Beleg appends exactly one page', async () => {
  const original = await buildPdfFixture(['Original Seite 1']);

  const merged = await mergeBelegInPdf(original, PNG_1X1, 'image/png');

  const reloaded = await PDFDocument.load(merged);
  assert.equal(reloaded.getPageCount(), 2, 'original 1 page + 1 appended image page');
});

test('merging a JPEG Beleg appends exactly one page', async () => {
  const original = await buildPdfFixture(['Original Seite 1']);

  const merged = await mergeBelegInPdf(original, JPEG_1X1, 'image/jpeg');

  const reloaded = await PDFDocument.load(merged);
  assert.equal(reloaded.getPageCount(), 2, 'original 1 page + 1 appended image page');
});

test('the original pages stay first and unchanged after merging', async () => {
  const original = await buildPdfFixture(['Original Seite 1']);
  const beleg = await buildPdfFixture(['Beleg Seite 1']);

  const merged = await mergeBelegInPdf(original, beleg, 'application/pdf');

  const originalReloaded = await PDFDocument.load(original);
  const mergedReloaded = await PDFDocument.load(merged);
  assert.deepEqual(mergedReloaded.getPage(0).getSize(), originalReloaded.getPage(0).getSize());
});

test('rejects garbage Beleg bytes claiming to be a PDF', async () => {
  const original = await buildPdfFixture(['Original Seite 1']);

  await assert.rejects(() => mergeBelegInPdf(original, Buffer.from('not a pdf'), 'application/pdf'));
});

test('rejects garbage Beleg bytes claiming to be a PNG', async () => {
  const original = await buildPdfFixture(['Original Seite 1']);

  await assert.rejects(() => mergeBelegInPdf(original, Buffer.from('not a png'), 'image/png'));
});

test('detectBelegMimetype recognizes a real PDF', async () => {
  const pdf = await buildPdfFixture(['Seite 1']);
  assert.equal(detectBelegMimetype(pdf), 'application/pdf');
});

test('detectBelegMimetype recognizes a real PNG', () => {
  assert.equal(detectBelegMimetype(PNG_1X1), 'image/png');
});

test('detectBelegMimetype recognizes a real JPEG', () => {
  assert.equal(detectBelegMimetype(JPEG_1X1), 'image/jpeg');
});

test('detectBelegMimetype returns null for unrecognized bytes', () => {
  assert.equal(detectBelegMimetype(Buffer.from('not a file at all')), null);
});

test('countBelegSeiten reports exactly the page count mergeBelegInPdf will add, for every supported Beleg type', async () => {
  const original = await buildPdfFixture(['Original Seite 1']);
  const mehrseitigerBeleg = await buildPdfFixture(['Beleg Seite 1', 'Beleg Seite 2', 'Beleg Seite 3']);

  assert.equal(await countBelegSeiten(mehrseitigerBeleg, 'application/pdf'), 3);
  assert.equal(await countBelegSeiten(PNG_1X1, 'image/png'), 1);
  assert.equal(await countBelegSeiten(JPEG_1X1, 'image/jpeg'), 1);

  // Der eigentliche Vertrag: der gemeldete Wert ist genau der Zuwachs durch mergeBelegInPdf --
  // darauf verlässt sich der spätere Splitgruppen-Merge, um die Belegseiten exakt zu lokalisieren.
  for (const [beleg, mimetype] of [[mehrseitigerBeleg, 'application/pdf'], [PNG_1X1, 'image/png'], [JPEG_1X1, 'image/jpeg']]) {
    const merged = await PDFDocument.load(await mergeBelegInPdf(original, beleg, mimetype));
    assert.equal(merged.getPageCount(), 1 + (await countBelegSeiten(beleg, mimetype)));
  }
});

test('buildBelegPdf returns a PDF Beleg unchanged', async () => {
  const original = await buildPdfFixture(['Seite 1', 'Seite 2']);

  const result = await buildBelegPdf(original, 'application/pdf');

  const reloaded = await PDFDocument.load(result);
  assert.equal(reloaded.getPageCount(), 2);
});

test('buildBelegPdf wraps a PNG Beleg into a fresh one-page PDF', async () => {
  const result = await buildBelegPdf(PNG_1X1, 'image/png');

  const reloaded = await PDFDocument.load(result);
  assert.equal(reloaded.getPageCount(), 1);
});

test('buildBelegPdf wraps a JPEG Beleg into a fresh one-page PDF', async () => {
  const result = await buildBelegPdf(JPEG_1X1, 'image/jpeg');

  const reloaded = await PDFDocument.load(result);
  assert.equal(reloaded.getPageCount(), 1);
});

test('a huge landscape image is normalized to an A4 landscape page, not embedded at its own pixel size', async () => {
  const original = await buildPdfFixture(['Original Seite 1']);
  const riesigesQuerbild = buildSolidPng(4032, 3024); // e.g. a phone photo, in raw pixels

  const merged = await mergeBelegInPdf(original, riesigesQuerbild, 'image/png');

  const reloaded = await PDFDocument.load(merged);
  const belegSeite = reloaded.getPage(1);
  assert.deepEqual(belegSeite.getSize(), { width: A4_HOCH_HOEHE, height: A4_HOCH_BREITE });
});

test('a huge portrait image is normalized to an A4 portrait page', async () => {
  const original = await buildPdfFixture(['Original Seite 1']);
  const riesigesHochbild = buildSolidPng(3024, 4032);

  const merged = await mergeBelegInPdf(original, riesigesHochbild, 'image/png');

  const reloaded = await PDFDocument.load(merged);
  const belegSeite = reloaded.getPage(1);
  assert.deepEqual(belegSeite.getSize(), { width: A4_HOCH_BREITE, height: A4_HOCH_HOEHE });
});

test('an oversized PDF Beleg page is also normalized to fit within A4', async () => {
  const original = await buildPdfFixture(['Original Seite 1']);
  // A PDF page that is itself much larger than A4 (e.g. from a scanning app using pixel-as-point).
  const riesigerPdfBeleg = await buildPdfFixture(['Riesige Beleg Seite'], { width: 3024, height: 4032 });

  const merged = await mergeBelegInPdf(original, riesigerPdfBeleg, 'application/pdf');

  const reloaded = await PDFDocument.load(merged);
  const belegSeite = reloaded.getPage(1);
  const { width, height } = belegSeite.getSize();
  const a4MaxSeite = A4_HOCH_HOEHE; // the longer A4 edge — bounds either orientation
  assert.ok(width <= a4MaxSeite + 0.01 && height <= a4MaxSeite + 0.01);
});
