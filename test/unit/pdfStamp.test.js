import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import * as mupdf from 'mupdf';
import { stampAndFinalize } from '../../src/services/pdfStamp.js';
import { buildPdfFixture } from '../helpers/pdfFixture.js';

function sampleFreigeber1() {
  return { name: 'Max Muster', identitaet: 'ct-123', zeitpunkt: '2026-08-15T08:30:00.000Z', ip: '1.2.3.4', interessenskonflikt: false, kommentar: null };
}

function sampleFreigeber2() {
  return { name: 'Erika Beispiel', identitaet: 'ct-456', zeitpunkt: '2026-08-15T09:15:00.000Z', ip: '5.6.7.8', interessenskonflikt: true, kommentar: 'Verwandtschaft mit Lieferant' };
}

function sampleVerlauf() {
  return [
    { rolleLabel: 'Freigabe 1', name: 'Max Muster', identitaet: 'ct-123', zeitpunkt: '2026-08-15T08:30:00.000Z', ip: '1.2.3.4', interessenskonflikt: false, kommentar: null },
    { rolleLabel: 'Freigabe 2', name: 'Erika Beispiel', identitaet: 'ct-456', zeitpunkt: '2026-08-15T09:15:00.000Z', ip: '5.6.7.8', interessenskonflikt: true, kommentar: 'Verwandtschaft mit Lieferant' },
  ];
}

function sampleStampData() {
  return { freigeber1: sampleFreigeber1(), freigeber2: sampleFreigeber2(), verlauf: sampleVerlauf() };
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

test('stamps the last page when visumSeitePosition is "letzte", appends one Verlauf page', async () => {
  const pdf = await buildPdfFixture(['Rechnung Seite 1', 'Rechnung Seite 2', 'Visum / Rechnungsfreigabe']);
  const stamped = await stampAndFinalize(pdf, sampleStampData(), 'letzte');

  const reloaded = await PDFDocument.load(stamped);
  assert.equal(reloaded.getPageCount(), 4, 'original 3 pages + 1 appended Verlauf page');

  const text = extractedText(stamped, 2);
  assert.match(text, /Max Muster/);
  assert.match(text, /Erika Beispiel/);
  assert.match(text, /Interessenskonflikt: Nein/);
  assert.match(text, /Interessenskonflikt: Ja/);
  assert.match(text, /Verwandtschaft mit Lieferant/);
});

test('stamps the first page when visumSeitePosition is "erste", still appends the Verlauf page at the end', async () => {
  const pdf = await buildPdfFixture(['Visum / Rechnungsfreigabe', 'Rechnung Seite 1', 'Rechnung Seite 2']);
  const stamped = await stampAndFinalize(pdf, sampleStampData(), 'erste');

  const reloaded = await PDFDocument.load(stamped);
  assert.equal(reloaded.getPageCount(), 4);

  const text = extractedText(stamped, 0);
  assert.match(text, /Max Muster/);
  assert.match(text, /Erika Beispiel/);

  const verlaufText = extractedText(stamped, 3);
  assert.match(verlaufText, /Freigabe 1/);
  assert.match(verlaufText, /Freigabe 2/);
});

test('Verlauf page lists every entry with its rolleLabel, name, and kommentar', async () => {
  const pdf = await buildPdfFixture(['Rechnung Seite 1', 'Visum / Rechnungsfreigabe']);
  const stampData = sampleStampData();
  stampData.verlauf = [
    { rolleLabel: 'Freigabe 1', name: 'Hans Erst', identitaet: 'ct-1', zeitpunkt: '2026-08-01T08:00:00.000Z', ip: '1.1.1.1', interessenskonflikt: false, kommentar: null },
    { rolleLabel: 'Abgelehnt', name: 'Peter Zweit', identitaet: 'ct-2', zeitpunkt: '2026-08-02T08:00:00.000Z', ip: '2.2.2.2', interessenskonflikt: false, kommentar: 'Falsches Konto' },
    { rolleLabel: 'Freigabe 1', name: 'Hans Erst', identitaet: 'ct-1', zeitpunkt: '2026-08-03T08:00:00.000Z', ip: '1.1.1.1', interessenskonflikt: false, kommentar: null },
    { rolleLabel: 'Freigabe 2', name: 'Erika Beispiel', identitaet: 'ct-456', zeitpunkt: '2026-08-04T08:00:00.000Z', ip: '5.6.7.8', interessenskonflikt: false, kommentar: null },
  ];

  const stamped = await stampAndFinalize(pdf, stampData, 'letzte');
  const reloaded = await PDFDocument.load(stamped);
  const verlaufText = extractedText(stamped, reloaded.getPageCount() - 1);
  assert.match(verlaufText, /Hans Erst/);
  assert.match(verlaufText, /Peter Zweit/);
  assert.match(verlaufText, /Abgelehnt/);
  assert.match(verlaufText, /Falsches Konto/);
});

test('Verlauf longer than one page spills onto an additional appended page', async () => {
  const pdf = await buildPdfFixture(['Rechnung Seite 1', 'Visum / Rechnungsfreigabe']);
  const stampData = sampleStampData();
  // 60 two-line entries is comfortably more than fits on one page at 14pt line height
  // starting at y = pageHeight - 50 with a y >= 40 cutoff (about 55 lines per page).
  stampData.verlauf = Array.from({ length: 60 }, (_, i) => ({
    rolleLabel: 'Freigabe 1',
    name: `Person ${i}`,
    identitaet: `ct-${i}`,
    zeitpunkt: '2026-08-15T08:30:00.000Z',
    ip: '1.2.3.4',
    interessenskonflikt: false,
    kommentar: `Zeile ${i}`,
  }));

  const stamped = await stampAndFinalize(pdf, stampData, 'letzte');
  const reloaded = await PDFDocument.load(stamped);
  assert.ok(reloaded.getPageCount() >= 4, `expected at least 2 Verlauf pages beyond the original 2, got ${reloaded.getPageCount()} total pages`);

  const lastPageText = extractedText(stamped, reloaded.getPageCount() - 1);
  assert.match(lastPageText, /Person 59/, 'the final entry must appear on the last page, proving nothing was silently dropped');
});

test('freigeber2 Kommentar longer than one line wraps instead of overflowing off the page', async () => {
  const pdf = await buildPdfFixture(['Rechnung Seite 1', 'Visum / Rechnungsfreigabe']);
  const stampData = sampleStampData();
  const longKommentar =
    'Dies ist eine sehr lange Begründung für die Ablehnung dieser Rechnung, die weit über die Breite ' +
    'einer einzelnen Zeile im PDF hinausgeht und daher umgebrochen werden muss, damit sie vollständig sichtbar bleibt.';
  stampData.freigeber2.kommentar = longKommentar;

  const stamped = await stampAndFinalize(pdf, stampData, 'letzte');
  const text = extractedText(stamped, 1);
  const lastWord = longKommentar.trim().split(' ').at(-1);
  assert.ok(text.includes(lastWord), 'the full long Kommentar must be present, not truncated');

  // freigeber1 (4 fixed fields, no kommentar) + freigeber2's 4 fixed fields = 8 lines if the
  // long Kommentar were (wrongly) drawn as a single unwrapped line. Wrapping must add more.
  const lineCount = text.split('\n').filter((line) => line.trim().length > 0).length;
  assert.ok(lineCount > 9, `expected the wrapped Kommentar to add extra lines, got ${lineCount} total lines`);
});

test('Verlauf entry with a long Kommentar wraps instead of overflowing off the page', async () => {
  const pdf = await buildPdfFixture(['Rechnung Seite 1', 'Visum / Rechnungsfreigabe']);
  const stampData = sampleStampData();
  const longKommentar =
    'Diese Rechnung wurde abgelehnt, weil die Kontierung nicht mit dem hinterlegten Konto übereinstimmt ' +
    'und die Belegsumme deutlich von der ursprünglichen Bestellung abweicht, was eine erneute Prüfung erfordert.';
  stampData.verlauf[1].kommentar = longKommentar;

  const stamped = await stampAndFinalize(pdf, stampData, 'letzte');
  const reloaded = await PDFDocument.load(stamped);
  const verlaufText = extractedText(stamped, reloaded.getPageCount() - 1);
  const lastWord = longKommentar.trim().split(' ').at(-1);
  assert.ok(verlaufText.includes(lastWord), 'the full long Verlauf Kommentar must be present, not truncated');
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

test('throws a German-message Error when a Verlauf entry contains non-WinAnsi characters', async () => {
  const pdf = await buildPdfFixture(['Rechnung Seite 1', 'Visum / Rechnungsfreigabe']);
  const stampData = sampleStampData();
  stampData.verlauf[0].kommentar = '😀 nicht darstellbar';

  await assert.rejects(
    () => stampAndFinalize(pdf, stampData, 'letzte'),
    /PDF konnte nicht gestempelt werden/
  );
});
