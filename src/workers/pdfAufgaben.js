// Liste der PDF-Aufgaben, die der PDF-Worker (workers/pdfWorker.js) und – bei PDF_WORKER=aus – der
// Hauptthread (services/pdfArbeit.js) ausführen. Einzige Quelle für beide Betriebsarten: ein Name je
// bestehender reiner Funktion, keine eigene Logik ausser der kombinierten Eingangsanalyse.
//
// Dieses Modul lädt mupdf (WASM, top-level await) – im Worker-Betrieb darf es der Hauptthread nie
// statisch importieren.

import { pruefeEingangsPdf } from '../services/pdfEingang.js';
import { renderFirstPageThumbnail } from '../services/thumbnail.js';
import { scanQrBill } from '../services/qrBillScan.js';
import { extrahierePdfText } from '../services/pdfText.js';

// Fehlermeldung ohne Stack (geht als Text an den Aufrufer, der sie wie bisher protokolliert).
function meldung(err) {
  return String(err?.message ?? err);
}

/**
 * Vorschaubild, QR-Erkennung und optional Text in einem Auftrag (Rechnungseingang POST /api/n8n/jobs).
 * Ein Fehlschlag eines Teils verhindert die anderen nicht; der Fehlertext steht im jeweiligen *Fehler-Feld.
 * @param {Buffer} buffer
 * @param {{text?: boolean}} [optionen] text: auch den Text extrahieren (nur nötig für die Kreditkartenerkennung)
 * @returns {{vorschaubild: Buffer|null, vorschaubildFehler: string|null, qr: object|null, qrFehler: string|null, text: string|null, textFehler: string|null}}
 */
function eingangAnalysieren(buffer, { text = false } = {}) {
  const ergebnis = { vorschaubild: null, vorschaubildFehler: null, qr: null, qrFehler: null, text: null, textFehler: null };
  try { ergebnis.vorschaubild = renderFirstPageThumbnail(buffer); } catch (err) { ergebnis.vorschaubildFehler = meldung(err); }
  try { ergebnis.qr = scanQrBill(buffer); } catch (err) { ergebnis.qrFehler = meldung(err); }
  if (text) {
    try { ergebnis.text = extrahierePdfText(buffer); } catch (err) { ergebnis.textFehler = meldung(err); }
  }
  return ergebnis;
}

// Aufgabenname → Funktion. Alle Argumente und Ergebnisse müssen per structured clone übertragbar sein.
export const AUFGABEN = {
  eingangPruefen: pruefeEingangsPdf,
  vorschaubild: renderFirstPageThumbnail,
  qrErkennen: scanQrBill,
  textExtrahieren: extrahierePdfText,
  eingangAnalysieren,
};
