// Nur für Tests: Aufgabenmodul für den PDF-Worker-Pool (Option `aufgabenModul`), ohne mupdf.
import { threadId } from 'node:worker_threads';
import { PdfEingangFehler, BelegBildFehler } from '../../src/services/pdfFehler.js';

export const AUFGABEN = {
  echo: (wert) => wert,
  threadId: () => threadId,
  schlafe: (ms) => new Promise((resolve) => setTimeout(() => resolve('wach'), ms)),
  // Blockiert synchron wie lange WASM-Arbeit (nur terminate() kann das abbrechen).
  blockiere: (ms) => { const ende = Date.now() + ms; while (Date.now() < ende) { /* rechnen */ } return 'fertig'; },
  absturz: () => { setTimeout(() => { throw new Error('Testabsturz'); }); return new Promise(() => {}); },
  beende: () => process.exit(3),
  speicherfresser: (mb) => { (globalThis.halde ??= []).push(Buffer.alloc(mb * 1024 * 1024, 1)); return 'gefressen'; },
  wirfEingangFehler: () => { throw new PdfEingangFehler('pdf_verschluesselt', 'Testmeldung verschlüsselt'); },
  wirfBelegBildFehler: () => { throw new BelegBildFehler('Testmeldung Bild zu gross'); },
  wirfTypFehler: () => { const err = new TypeError('kaputt'); err.code = 'E_TEST'; throw err; },
  // Für den 503-Test der n8n-Route: Eingangsprüfung, die das Zeitlimit sicher überschreitet.
  eingangPruefen: () => AUFGABEN.blockiere(60_000),
  bytes: (buf) => ({ laenge: buf.length, istBuffer: Buffer.isBuffer(buf), text: buf.toString('latin1'), kopie: Buffer.concat([buf, Buffer.from('!')]) }),
};
