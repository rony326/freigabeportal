import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { mergeBelegInPdf, detectBelegMimetype, countBelegSeiten } from '../../src/services/belegAnhaengen.js';
import { buildPdfFixture } from '../helpers/pdfFixture.js';
import { PNG_1X1, JPEG_1X1 } from '../helpers/imageFixture.js';

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
