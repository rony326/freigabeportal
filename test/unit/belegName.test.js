// Rückmeldung 2026-10-26: Die KK-Abrechnungs-Auswahl im Pool zeigte "#2 image002.png" — den Namen
// eines Bild-Anhangs (Mail-Signatur), nicht den der Rechnungs-PDF. Anzeige jetzt: PDF-Dateiname
// (Teil "pdf" des n8n-Uploads), sonst ein .pdf-Anzeigename, sonst "Eingang <Datum>".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { belegName, belegLabel } from '../../src/services/belegName.js';

const basis = { id: 2, quelle: 'lieferant', eingang_am: '2026-10-23T11:10:00.000Z' };

test('PDF-Dateiname des Uploads hat Vorrang vor einem Bild-Anzeigenamen', () => {
  const job = { ...basis, dateiname: 'image002.png', pdf_dateiname: 'Rechnung_4711.pdf' };
  assert.equal(belegName(job), 'Rechnung_4711.pdf');
  assert.equal(belegLabel(job), '#2 Rechnung_4711.pdf');
});

test('Bild-Anzeigename ohne PDF-Dateiname → "Eingang <Datum>" (Ortszeit)', () => {
  const job = { ...basis, dateiname: 'image002.png', pdf_dateiname: null };
  assert.equal(belegName(job), 'Eingang 23.10.2026 13:10');
  assert.equal(belegLabel(job), '#2 Eingang 23.10.2026 13:10');
});

test('PDF-Upload ohne sinnvollen Namen (nur Bildname/leer) fällt ebenfalls auf Eingang zurück', () => {
  assert.equal(belegName({ ...basis, dateiname: 'IMAGE001.JPG', pdf_dateiname: 'image001.jpg' }), 'Eingang 23.10.2026 13:10');
  assert.equal(belegName({ ...basis, dateiname: '', pdf_dateiname: '' }), 'Eingang 23.10.2026 13:10');
});

test('.pdf-Anzeigename bleibt, auch wenn der Upload-Teil generisch heisst', () => {
  assert.equal(belegName({ ...basis, dateiname: 'Rechnung März.pdf', pdf_dateiname: 'blob' }), 'Rechnung März.pdf');
  assert.equal(belegName({ ...basis, dateiname: 'Rechnung März.PDF', pdf_dateiname: null }), 'Rechnung März.PDF');
});

test('Anzeigename ohne Bild-Endung bleibt (z. B. Scanner-Name ohne Endung)', () => {
  assert.equal(belegName({ ...basis, quelle: 'scanner', dateiname: 'Scan 2026-10-23', pdf_dateiname: null }), 'Scan 2026-10-23');
});

test('Spesen: der von der Person hochgeladene Belegname bleibt unverändert', () => {
  assert.equal(belegName({ ...basis, quelle: 'spesen', dateiname: 'quittung.jpg', pdf_dateiname: null }), 'quittung.jpg');
});

test('ohne Job-ID kein "#"', () => {
  assert.equal(belegLabel({ dateiname: 'a.pdf' }), 'a.pdf');
});
