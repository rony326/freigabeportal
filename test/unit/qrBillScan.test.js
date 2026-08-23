import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument as PdfLibDocument } from 'pdf-lib';
import { scanQrBill } from '../../src/services/qrBillScan.js';
import { buildQrBillPdfFixture } from '../helpers/qrBillFixture.js';
import { buildPdfFixture } from '../helpers/pdfFixture.js';

const QR_BILL_DATA = {
  amount: 1949.75,
  creditor: {
    account: 'CH4431999123000889012',
    address: 'Musterstrasse',
    buildingNumber: 7,
    city: 'Musterstadt',
    country: 'CH',
    name: 'Muster AG',
    zip: 1234,
  },
  currency: 'CHF',
  debtor: {
    address: 'Musterstrasse',
    buildingNumber: 1,
    city: 'Musterstadt',
    country: 'CH',
    name: 'Peter Muster',
    zip: 1234,
  },
  reference: '210000000003139471430009017',
};

test('scanQrBill decodes a real Swiss QR-bill PDF on page 1', async () => {
  const pdf = await buildQrBillPdfFixture(QR_BILL_DATA);
  const result = scanQrBill(pdf);
  assert.ok(result, 'expected a decoded QR-bill payload');
  assert.equal(result.iban, 'CH4431999123000889012');
  assert.equal(result.creditorName, 'Muster AG');
  assert.equal(result.betrag, '1949.75');
  assert.equal(result.waehrung, 'CHF');
  assert.equal(result.referenz, '210000000003139471430009017');
});

test('scanQrBill falls back to the last page when the QR-Code is not on page 1', async () => {
  const qrBillPdf = await buildQrBillPdfFixture(QR_BILL_DATA);

  const combined = await PdfLibDocument.create();
  combined.addPage([595, 842]); // blank cover page — no QR code here

  const qrDoc = await PdfLibDocument.load(qrBillPdf);
  const qrPages = await combined.copyPages(qrDoc, qrDoc.getPageIndices());
  qrPages.forEach((page) => combined.addPage(page));

  const pdf = Buffer.from(await combined.save());
  const result = scanQrBill(pdf);
  assert.ok(result, 'expected the QR-Code on a later page to be found via the last-page fallback');
  assert.equal(result.iban, 'CH4431999123000889012');
});

test('scanQrBill returns null for a PDF without any QR-Code', async () => {
  const pdf = await buildPdfFixture(['Ganz normale Rechnung ohne QR-Code']);
  assert.equal(scanQrBill(pdf), null);
});

test('scanQrBill throws a defined Error for a corrupt PDF, does not crash', () => {
  const corrupt = Buffer.from('%PDF-1.4\n%not-a-real-pdf-body\n');
  assert.throws(() => scanQrBill(corrupt), Error);
});

test('scanQrBill clamps rasterization for a degenerate narrow/tall page and returns null quickly, instead of an unbounded pixmap', async () => {
  // A page like [50, 5000] is legal PDF geometry (well within mupdf's own limits) but, without a
  // pixel-count clamp, `scale = SCAN_WIDTH_PX / width` alone would blow the rendered height up to
  // match the declared width-to-height ratio — an unbounded-memory DoS reachable from any
  // untrusted PDF ingested via POST /n8n/jobs. This asserts the fix (capping total scanned
  // pixels) makes such a page render too small for jsQR to find anything, completing fast instead
  // of hanging or exhausting memory.
  const doc = await PdfLibDocument.create();
  doc.addPage([50, 5000]);
  const pdf = Buffer.from(await doc.save());

  const start = Date.now();
  const result = scanQrBill(pdf);
  const elapsedMs = Date.now() - start;

  assert.equal(result, null);
  assert.ok(elapsedMs < 2000, `expected scanQrBill to complete quickly, took ${elapsedMs}ms`);
});
