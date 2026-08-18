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
  return {
    konto: { nummer: '3000', bezeichnung: 'Unterhalt' },
    freigeber1: sampleFreigeber1(),
    freigeber2: sampleFreigeber2(),
    verlauf: sampleVerlauf(),
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

test('appends exactly one new page (not merged into existing content) carrying both Freigaben and the Verlauf', async () => {
  const pdf = await buildPdfFixture(['Rechnung Seite 1', 'Rechnung Seite 2']);
  const stamped = await stampAndFinalize(pdf, sampleStampData());

  const reloaded = await PDFDocument.load(stamped);
  assert.equal(reloaded.getPageCount(), 3, 'original 2 pages + 1 appended stamp page');

  const original = extractedText(stamped, 0);
  assert.doesNotMatch(original, /Max Muster/, 'the original content page must be untouched');

  const stampText = extractedText(stamped, 2);
  assert.match(stampText, /Max Muster/);
  assert.match(stampText, /Erika Beispiel/);
  assert.match(stampText, /Interessenskonflikt: Nein/);
  assert.match(stampText, /Interessenskonflikt: Ja/);
  assert.match(stampText, /Verwandtschaft mit Lieferant/);
  assert.match(stampText, /Verlauf/, 'the audit-log Verlauf section starts on the same page as the Freigaben');
  assert.match(stampText, /Freigabe 1/);
  assert.match(stampText, /Freigabe 2/);
  assert.match(stampText, /Konto: 3000 — Unterhalt/, 'the Kontonummer must be prominently shown at the top of the stamp page');
});

test('the Konto line is drawn before (above) the Freigabe 1 block', async () => {
  const pdf = await buildPdfFixture(['Rechnung Seite 1']);
  const stamped = await stampAndFinalize(pdf, sampleStampData());
  const reloaded = await PDFDocument.load(stamped);
  const stampText = extractedText(stamped, reloaded.getPageCount() - 1);
  const kontoIndex = stampText.indexOf('Konto: 3000');
  const freigabe1Index = stampText.indexOf('Freigabe 1');
  assert.ok(kontoIndex >= 0 && freigabe1Index >= 0 && kontoIndex < freigabe1Index);
});

test('omitting stampData.konto skips the Konto line without error', async () => {
  const pdf = await buildPdfFixture(['Rechnung Seite 1']);
  const stampData = sampleStampData();
  delete stampData.konto;
  const stamped = await stampAndFinalize(pdf, stampData);
  const reloaded = await PDFDocument.load(stamped);
  const stampText = extractedText(stamped, reloaded.getPageCount() - 1);
  assert.doesNotMatch(stampText, /Konto:/);
  assert.match(stampText, /Freigabe 1/);
});

test('the appended stamp page reuses the original document\'s page size', async () => {
  const pdf = await buildPdfFixture(['Rechnung Seite 1']);
  const original = await PDFDocument.load(pdf);
  const { width: originalWidth, height: originalHeight } = original.getPage(0).getSize();

  const stamped = await stampAndFinalize(pdf, sampleStampData());
  const reloaded = await PDFDocument.load(stamped);
  const stampPage = reloaded.getPage(reloaded.getPageCount() - 1);
  assert.equal(stampPage.getWidth(), originalWidth);
  assert.equal(stampPage.getHeight(), originalHeight);
});

test('Verlauf page lists every entry with its rolleLabel, name, and kommentar', async () => {
  const pdf = await buildPdfFixture(['Rechnung Seite 1']);
  const stampData = sampleStampData();
  stampData.verlauf = [
    { rolleLabel: 'Freigabe 1', name: 'Hans Erst', identitaet: 'ct-1', zeitpunkt: '2026-08-01T08:00:00.000Z', ip: '1.1.1.1', interessenskonflikt: false, kommentar: null },
    { rolleLabel: 'Abgelehnt', name: 'Peter Zweit', identitaet: 'ct-2', zeitpunkt: '2026-08-02T08:00:00.000Z', ip: '2.2.2.2', interessenskonflikt: false, kommentar: 'Falsches Konto' },
    { rolleLabel: 'Freigabe 1', name: 'Hans Erst', identitaet: 'ct-1', zeitpunkt: '2026-08-03T08:00:00.000Z', ip: '1.1.1.1', interessenskonflikt: false, kommentar: null },
    { rolleLabel: 'Freigabe 2', name: 'Erika Beispiel', identitaet: 'ct-456', zeitpunkt: '2026-08-04T08:00:00.000Z', ip: '5.6.7.8', interessenskonflikt: false, kommentar: null },
  ];

  const stamped = await stampAndFinalize(pdf, stampData);
  const reloaded = await PDFDocument.load(stamped);
  const stampText = extractedText(stamped, reloaded.getPageCount() - 1);
  assert.match(stampText, /Hans Erst/);
  assert.match(stampText, /Peter Zweit/);
  assert.match(stampText, /Abgelehnt/);
  assert.match(stampText, /Falsches Konto/);
});

test('Verlauf longer than one page spills onto an additional appended page', async () => {
  const pdf = await buildPdfFixture(['Rechnung Seite 1']);
  const stampData = sampleStampData();
  // 60 two-line entries is comfortably more than fits below the two Freigabe blocks on one page.
  stampData.verlauf = Array.from({ length: 60 }, (_, i) => ({
    rolleLabel: 'Freigabe 1',
    name: `Person ${i}`,
    identitaet: `ct-${i}`,
    zeitpunkt: '2026-08-15T08:30:00.000Z',
    ip: '1.2.3.4',
    interessenskonflikt: false,
    kommentar: `Zeile ${i}`,
  }));

  const stamped = await stampAndFinalize(pdf, stampData);
  const reloaded = await PDFDocument.load(stamped);
  assert.ok(reloaded.getPageCount() >= 3, `expected at least one Verlauf continuation page beyond the original 1 + stamp page, got ${reloaded.getPageCount()} total pages`);

  const lastPageText = extractedText(stamped, reloaded.getPageCount() - 1);
  assert.match(lastPageText, /Person 59/, 'the final entry must appear on the last page, proving nothing was silently dropped');
});

test('freigeber2 Kommentar longer than one line wraps instead of overflowing off the page', async () => {
  const pdf = await buildPdfFixture(['Rechnung Seite 1']);
  const stampData = sampleStampData();
  const longKommentar =
    'Dies ist eine sehr lange Begründung für die Ablehnung dieser Rechnung, die weit über die Breite ' +
    'einer einzelnen Zeile im PDF hinausgeht und daher umgebrochen werden muss, damit sie vollständig sichtbar bleibt.';
  stampData.freigeber2.kommentar = longKommentar;

  const stamped = await stampAndFinalize(pdf, stampData);
  const reloaded = await PDFDocument.load(stamped);
  const text = extractedText(stamped, reloaded.getPageCount() - 1);
  const lastWord = longKommentar.trim().split(' ').at(-1);
  assert.ok(text.includes(lastWord), 'the full long Kommentar must be present, not truncated');
});

test('Verlauf entry with a long Kommentar wraps instead of overflowing off the page', async () => {
  const pdf = await buildPdfFixture(['Rechnung Seite 1']);
  const stampData = sampleStampData();
  const longKommentar =
    'Diese Rechnung wurde abgelehnt, weil die Kontierung nicht mit dem hinterlegten Konto übereinstimmt ' +
    'und die Belegsumme deutlich von der ursprünglichen Bestellung abweicht, was eine erneute Prüfung erfordert.';
  stampData.verlauf[1].kommentar = longKommentar;

  const stamped = await stampAndFinalize(pdf, stampData);
  const reloaded = await PDFDocument.load(stamped);
  const stampText = extractedText(stamped, reloaded.getPageCount() - 1);
  const lastWord = longKommentar.trim().split(' ').at(-1);
  assert.ok(stampText.includes(lastWord), 'the full long Verlauf Kommentar must be present, not truncated');
});

test('throws a German-message Error for a PDF that cannot be loaded', async () => {
  await assert.rejects(
    () => stampAndFinalize(Buffer.alloc(0), sampleStampData()),
    /PDF konnte nicht geladen werden/
  );
});

test('throws a German-message Error (not a raw TypeError) for a PDF that loads leniently but has no real page tree', async () => {
  await assert.rejects(
    () => stampAndFinalize(NOT_REALLY_A_PDF, sampleStampData()),
    (err) => {
      assert.ok(err instanceof Error);
      assert.notEqual(err.constructor.name, 'TypeError');
      assert.match(err.message, /PDF konnte nicht gestempelt werden/);
      return true;
    }
  );
});

test('throws a German-message Error (not a raw pdf-lib WinAnsi error) when stamp text contains non-WinAnsi characters', async () => {
  const pdf = await buildPdfFixture(['Rechnung Seite 1']);
  const stampData = sampleStampData();
  stampData.freigeber2.kommentar = '😀 nicht darstellbar';

  await assert.rejects(
    () => stampAndFinalize(pdf, stampData),
    (err) => {
      assert.ok(err instanceof Error);
      assert.doesNotMatch(err.message, /WinAnsi/);
      assert.match(err.message, /PDF konnte nicht gestempelt werden/);
      return true;
    }
  );
});

test('throws a German-message Error when a Verlauf entry contains non-WinAnsi characters', async () => {
  const pdf = await buildPdfFixture(['Rechnung Seite 1']);
  const stampData = sampleStampData();
  stampData.verlauf[0].kommentar = '😀 nicht darstellbar';

  await assert.rejects(
    () => stampAndFinalize(pdf, stampData),
    /PDF konnte nicht gestempelt werden/
  );
});
