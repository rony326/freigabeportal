import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pruefeEingangsPdf, PdfEingangFehler } from '../../src/services/pdfEingang.js';
import { buildPdfFixture, buildTextlosesPdfFixture, buildVerschluesseltesPdfFixture, buildSeitenlosesPdfFixture } from '../helpers/pdfFixture.js';
import { buildQrBillPdfFixture } from '../helpers/qrBillFixture.js';

async function code(bytes) {
  try {
    await pruefeEingangsPdf(bytes);
    return 'ok';
  } catch (err) {
    assert.ok(err instanceof PdfEingangFehler, `unexpected error type: ${err}`);
    return err.code;
  }
}

test('pruefeEingangsPdf akzeptiert lesbare PDFs mit und ohne QR-Code und ohne Textebene', async () => {
  assert.deepEqual(await pruefeEingangsPdf(await buildPdfFixture(['Seite 1', 'Seite 2'])), { seiten: 2 });
  assert.equal(await code(await buildTextlosesPdfFixture()), 'ok');
  const qr = await buildQrBillPdfFixture({
    amount: 10,
    creditor: { account: 'CH4431999123000889012', address: 'Musterstrasse', buildingNumber: 7, city: 'Musterstadt', country: 'CH', name: 'Muster AG', zip: 1234 },
    currency: 'CHF',
    reference: '210000000003139471430009017',
  });
  assert.equal(await code(qr), 'ok');
});

test('pruefeEingangsPdf unterscheidet beschädigte, seitenlose und verschlüsselte Dokumente', async () => {
  assert.equal(await code(Buffer.from('%PDF kaputt')), 'pdf_beschaedigt');
  assert.equal(await code(Buffer.from('kein pdf')), 'pdf_beschaedigt');
  assert.equal(await code(Buffer.alloc(0)), 'pdf_beschaedigt');
  assert.equal(await code(await buildSeitenlosesPdfFixture()), 'pdf_keine_seiten');
  assert.equal(await code(await buildVerschluesseltesPdfFixture()), 'pdf_verschluesselt');
  assert.equal(await code(await buildVerschluesseltesPdfFixture({ userPasswort: null })), 'pdf_verschluesselt');
});
