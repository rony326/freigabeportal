// B2, Etappe 4: Beleg anhängen (pdf-lib embedPng eines grossen Bildes) blockiert die Event-Loop des Hauptthreads im
// Worker-Betrieb nicht – mit Gegenprobe im Inline-Betrieb (PDF_WORKER=aus), dass die Messung die Blockade erkennt.
// Testbild: einfarbiges PNG mit 3000 × 3000 Pixeln (9 MP, zur Laufzeit erzeugt, klein komprimiert, ~1 s Einbetten).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { erstellePdfArbeit } from '../../src/services/pdfArbeit.js';
import { buildPdfFixture } from '../helpers/pdfFixture.js';
import { buildSolidPng, PNG_1X1 } from '../helpers/imageFixture.js';

const MIN_DAUER_MS = 500;
let grossesPng;
let rechnung;

// Grösste Event-Loop-Verzögerung (ms) während des Anhängens, gemessen wie in pdfWorkerEventLoop.test.js.
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
    const ergebnis = await arbeit.ausfuehren('belegAnhaengen', [rechnung, grossesPng, 'image/png'], { spur: 'interaktiv' });
    const dauer = performance.now() - start;
    await new Promise((r) => setTimeout(r, 50));
    return { ergebnis, dauer, maxVerzoegerung };
  } finally {
    clearInterval(intervall);
  }
}

before(async () => {
  grossesPng = buildSolidPng(3000, 3000);
  rechnung = await buildPdfFixture(['Rechnung']);
});

const worker = erstellePdfArbeit({ modus: 'an', logger: { log() {}, warn() {}, error() {} } });
after(() => worker.schliessen());

test('B2 Etappe 4: Beleg anhängen im Worker blockiert die Event-Loop nicht; inline schon (Gegenprobe)', { timeout: 60_000 }, async (t) => {
  await worker.ausfuehren('belegAnhaengen', [rechnung, PNG_1X1, 'image/png']); // Worker gestartet
  const w = await miss(worker);
  t.diagnostic(`Worker: Dauer ${Math.round(w.dauer)} ms, max. Event-Loop-Verzögerung ${w.maxVerzoegerung.toFixed(1)} ms`);
  if (w.dauer < MIN_DAUER_MS) {
    t.skip(`Anhängen dauerte nur ${Math.round(w.dauer)} ms (< ${MIN_DAUER_MS} ms) – zu kurz, um eine Blockade sicher zu unterscheiden`);
    return;
  }
  assert.equal(w.ergebnis.belegSeiten, 1);
  assert.ok(w.maxVerzoegerung < 150, `Event-Loop im Worker-Betrieb um ${w.maxVerzoegerung.toFixed(1)} ms verzögert`);

  const inline = erstellePdfArbeit({ modus: 'aus' });
  await inline.ausfuehren('belegAnhaengen', [rechnung, PNG_1X1, 'image/png']); // Aufgabenmodul geladen
  const i = await miss(inline);
  t.diagnostic(`Inline: Dauer ${Math.round(i.dauer)} ms, max. Event-Loop-Verzögerung ${i.maxVerzoegerung.toFixed(1)} ms`);
  assert.ok(i.maxVerzoegerung >= 0.5 * i.dauer, `Gegenprobe: Inline-Verzögerung ${i.maxVerzoegerung.toFixed(1)} ms bei ${Math.round(i.dauer)} ms Dauer – die Messung erkennt keine Blockade`);
});
