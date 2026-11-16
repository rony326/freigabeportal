// PDF-Worker (worker_threads): führt die Aufgaben aus workers/pdfAufgaben.js ausserhalb der
// Event-Loop des Hauptthreads aus. Gesteuert von services/pdfWorkerPool.js.
//
// Protokoll: nach dem Laden der Aufgaben (inkl. mupdf) meldet der Worker {typ: 'bereit'}. Danach je
// Auftrag {id, aufgabe, args} → {typ: 'ergebnis', id, ok, ergebnis | fehler: {klasse, code, message},
// external, dauerMs}. `external` ist process.memoryUsage().external nach dem Auftrag: der WASM-Speicher
// von mupdf wächst und schrumpft nie, der Pool ersetzt den Worker oberhalb seiner Grenze.
// Ein Worker bearbeitet immer nur einen Auftrag gleichzeitig.

import { parentPort, workerData } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { kopiereFuerTransfer, alsBuffer, fehlerAlsDaten } from './pdfUebergabe.js';

const modul = await import(workerData?.aufgabenModul ?? new URL('./pdfAufgaben.js', import.meta.url).href);
const aufgaben = modul.AUFGABEN;
if (!aufgaben || typeof aufgaben !== 'object') throw new Error('Aufgabenmodul ohne AUFGABEN.');

parentPort.on('message', async ({ id, aufgabe, args }) => {
  const start = performance.now();
  let antwort;
  let transfer = [];
  try {
    const fn = Object.hasOwn(aufgaben, aufgabe) ? aufgaben[aufgabe] : null;
    if (typeof fn !== 'function') throw new Error(`Unbekannte PDF-Aufgabe: ${aufgabe}`);
    const ergebnis = await fn(...alsBuffer(args ?? []));
    const verpackt = kopiereFuerTransfer(ergebnis);
    transfer = verpackt.transfer;
    antwort = { typ: 'ergebnis', id, ok: true, ergebnis: verpackt.wert };
  } catch (err) {
    antwort = { typ: 'ergebnis', id, ok: false, fehler: fehlerAlsDaten(err) };
  }
  antwort.external = process.memoryUsage().external;
  antwort.dauerMs = Math.round(performance.now() - start);
  parentPort.postMessage(antwort, transfer);
});

parentPort.postMessage({ typ: 'bereit' });
