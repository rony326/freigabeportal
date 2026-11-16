// B2: Belegt, dass PDF-Arbeit im Worker die Event-Loop des Hauptthreads nicht blockiert – und mit der
// Gegenprobe im Inline-Betrieb (PDF_WORKER=aus), dass die Messung eine Blockade überhaupt erkennt.
// Testdatei: A4-Seite mit einem Rausch-JPEG (zur Laufzeit erzeugt); die QR-Erkennung findet darin
// nichts, braucht dafür aber Sekunden (jsQR auf 1200 px breitem Rauschen).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomFillSync } from 'node:crypto';
import * as mupdf from 'mupdf';
import { PDFDocument } from 'pdf-lib';
import { erstellePdfArbeit } from '../../src/services/pdfArbeit.js';
import { buildPdfFixture } from '../helpers/pdfFixture.js';

const MIN_DAUER_MS = 500;
let rauschPdf;
let kleinesPdf;

async function baueRauschPdf(breite = 600, hoehe = 850) {
  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, breite, hoehe], false);
  try {
    randomFillSync(pixmap.getPixels());
    const jpeg = pixmap.asJPEG(85, false);
    const doc = await PDFDocument.create();
    const bild = await doc.embedJpg(jpeg);
    doc.addPage([595.28, 841.89]).drawImage(bild, { x: 0, y: 0, width: 595.28, height: 841.89 });
    return Buffer.from(await doc.save());
  } finally {
    pixmap.destroy();
  }
}

// Misst die grösste Event-Loop-Verzögerung (ms) während eines QR-Scans mit einem 10-ms-Intervall:
// jede Verspätung eines Ticks gegenüber den erwarteten 10 ms ist Blockade. (monitorEventLoopDelay
// erfasste in Node 22 eine einzelne lange Blockade im Inline-Betrieb nicht zuverlässig.)
async function miss(arbeit) {
  let letzter = performance.now();
  let maxVerzoegerung = 0;
  const intervall = setInterval(() => {
    const jetzt = performance.now();
    maxVerzoegerung = Math.max(maxVerzoegerung, jetzt - letzter - 10);
    letzter = jetzt;
  }, 10);
  const start = performance.now();
  try {
    const ergebnis = await arbeit.ausfuehren('qrErkennen', [rauschPdf], { spur: 'interaktiv' });
    const dauer = performance.now() - start;
    // Noch ein paar Ticks, damit die letzte (verspätete) Runde in die Messung eingeht.
    await new Promise((r) => setTimeout(r, 50));
    return { ergebnis, dauer, maxVerzoegerung };
  } finally {
    clearInterval(intervall);
  }
}

before(async () => {
  rauschPdf = await baueRauschPdf();
  kleinesPdf = await buildPdfFixture(['Aufwärmen']);
});

const worker = erstellePdfArbeit({ modus: 'an', zeitlimits: { qrErkennen: 25_000 }, logger: { log() {}, warn() {}, error() {} } });
after(() => worker.schliessen());

test('Worker-Betrieb: QR-Scan blockiert die Event-Loop nicht; Inline-Betrieb blockiert sie (Gegenprobe)', { timeout: 30_000 }, async (t) => {
  await worker.ausfuehren('vorschaubild', [kleinesPdf]); // Worker gestartet, mupdf geladen
  const w = await miss(worker);
  t.diagnostic(`Worker: Dauer ${Math.round(w.dauer)} ms, max. Event-Loop-Verzögerung ${w.maxVerzoegerung.toFixed(1)} ms`);
  if (w.dauer < MIN_DAUER_MS) {
    t.skip(`QR-Scan dauerte nur ${Math.round(w.dauer)} ms (< ${MIN_DAUER_MS} ms) – zu kurz, um eine Blockade sicher zu unterscheiden`);
    return;
  }
  assert.equal(w.ergebnis, null, 'Rauschen enthält keinen QR-Code');
  assert.ok(w.maxVerzoegerung < 150, `Event-Loop im Worker-Betrieb um ${w.maxVerzoegerung.toFixed(1)} ms verzögert`);

  const inline = erstellePdfArbeit({ modus: 'aus' });
  await inline.ausfuehren('vorschaubild', [kleinesPdf]); // Aufgabenmodul geladen
  const i = await miss(inline);
  t.diagnostic(`Inline: Dauer ${Math.round(i.dauer)} ms, max. Event-Loop-Verzögerung ${i.maxVerzoegerung.toFixed(1)} ms`);
  assert.ok(i.maxVerzoegerung >= 0.8 * i.dauer, `Gegenprobe: Inline-Verzögerung ${i.maxVerzoegerung.toFixed(1)} ms bei ${Math.round(i.dauer)} ms Dauer – die Messung erkennt keine Blockade`);
});
