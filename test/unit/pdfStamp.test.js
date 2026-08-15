import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import * as mupdf from 'mupdf';
import { stampAndFinalize } from '../../src/services/pdfStamp.js';
import { buildPdfFixture } from '../helpers/pdfFixture.js';

function sampleStampData() {
  return {
    freigeber1: { name: 'Max Muster', identitaet: 'ct-123', zeitpunkt: '2026-08-15T08:30:00.000Z', ip: '1.2.3.4', interessenskonflikt: false, kommentar: null },
    freigeber2: { name: 'Erika Beispiel', identitaet: 'ct-456', zeitpunkt: '2026-08-15T09:15:00.000Z', ip: '5.6.7.8', interessenskonflikt: true, kommentar: 'Verwandtschaft mit Lieferant' },
  };
}

// Same fixture shape used as PDF_BYTES in test/integration/n8n/jobs.test.js: pdf-lib's
// PDFDocument.load() parses this leniently and succeeds, but it is not a real, usable PDF.
const NOT_REALLY_A_PDF = Buffer.from('%PDF-1.4\n%test-fixture-not-a-real-pdf-body\n');

function extractedText(stampedBytes, pageIndex) {
  const doc = mupdf.Document.openDocument(stampedBytes, 'application/pdf');
  try {
    const page = doc.loadPage(pageIndex);
    try {
      return page.toStructuredText().asText();
    } finally {
      page.destroy();
    }
  } finally {
    doc.destroy();
  }
}

test('stamps the last page when visumSeitePosition is "letzte", keeps page count unchanged', async () => {
  const pdf = await buildPdfFixture(['Rechnung Seite 1', 'Rechnung Seite 2', 'Visum / Rechnungsfreigabe']);
  const stamped = await stampAndFinalize(pdf, sampleStampData(), 'letzte');

  const reloaded = await PDFDocument.load(stamped);
  assert.equal(reloaded.getPageCount(), 3);

  const text = extractedText(stamped, 2);
  assert.match(text, /Max Muster/);
  assert.match(text, /Erika Beispiel/);
  assert.match(text, /Interessenskonflikt: Nein/);
  assert.match(text, /Interessenskonflikt: Ja/);
  assert.match(text, /Verwandtschaft mit Lieferant/);
});

test('stamps the first page when visumSeitePosition is "erste", keeps page count unchanged', async () => {
  const pdf = await buildPdfFixture(['Visum / Rechnungsfreigabe', 'Rechnung Seite 1', 'Rechnung Seite 2']);
  const stamped = await stampAndFinalize(pdf, sampleStampData(), 'erste');

  const reloaded = await PDFDocument.load(stamped);
  assert.equal(reloaded.getPageCount(), 3);

  const text = extractedText(stamped, 0);
  assert.match(text, /Max Muster/);
  assert.match(text, /Erika Beispiel/);
});

test('throws a German-message Error for a PDF that cannot be loaded', async () => {
  await assert.rejects(
    () => stampAndFinalize(Buffer.alloc(0), sampleStampData(), 'letzte'),
    /PDF konnte nicht geladen werden/
  );
});

test('throws a German-message Error (not a raw TypeError) for a PDF that loads leniently but has no real page tree', async () => {
  await assert.rejects(
    () => stampAndFinalize(NOT_REALLY_A_PDF, sampleStampData(), 'letzte'),
    (err) => {
      assert.ok(err instanceof Error);
      assert.notEqual(err.constructor.name, 'TypeError');
      assert.match(err.message, /PDF konnte nicht gestempelt werden/);
      return true;
    }
  );
});

test('throws a German-message Error (not a raw pdf-lib WinAnsi error) when stamp text contains non-WinAnsi characters', async () => {
  const pdf = await buildPdfFixture(['Rechnung Seite 1', 'Visum / Rechnungsfreigabe']);
  const stampData = sampleStampData();
  stampData.freigeber2.kommentar = '😀 nicht darstellbar';

  await assert.rejects(
    () => stampAndFinalize(pdf, stampData, 'letzte'),
    (err) => {
      assert.ok(err instanceof Error);
      assert.doesNotMatch(err.message, /WinAnsi/);
      assert.match(err.message, /PDF konnte nicht gestempelt werden/);
      return true;
    }
  );
});
