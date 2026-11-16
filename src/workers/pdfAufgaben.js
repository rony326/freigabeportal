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
import { buildBelegPdf, belegInPdfAnhaengen } from '../services/belegAnhaengen.js';

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

/**
 * Belegdatei für Spesen und Kreditkarten-Belege: Upload als PDF (ein Bild wird auf eine A4-Seite eingebettet, ein PDF
 * bleibt unverändert, siehe buildBelegPdf) plus Vorschaubild der ersten Seite. Ein Bild bis 40 Megapixel zu dekodieren
 * (pdf-lib embedPng) dauert Sekunden – deshalb im Worker, nicht nur das Vorschaubild.
 * Ein Fehlschlag des Vorschaubilds ist kein Fehler des Auftrags (vorschaubildFehler); ein Fehler von buildBelegPdf
 * (z. B. BelegBildFehler) scheitert wie beim direkten Aufruf.
 * @param {Buffer} buffer
 * @param {'application/pdf'|'image/png'|'image/jpeg'} mimetype
 * @returns {Promise<{pdf: Buffer, vorschaubild: Buffer|null, vorschaubildFehler: string|null}>}
 */
async function belegDateiErstellen(buffer, mimetype) {
  const pdf = await buildBelegPdf(buffer, mimetype);
  const ergebnis = { pdf, vorschaubild: null, vorschaubildFehler: null };
  try { ergebnis.vorschaubild = renderFirstPageThumbnail(pdf); } catch (err) { ergebnis.vorschaubildFehler = meldung(err); }
  return ergebnis;
}

// Aufgabenname → Funktion. Alle Argumente und Ergebnisse müssen per structured clone übertragbar sein.
export const AUFGABEN = {
  eingangPruefen: pruefeEingangsPdf,
  vorschaubild: renderFirstPageThumbnail,
  qrErkennen: scanQrBill,
  textExtrahieren: extrahierePdfText,
  eingangAnalysieren,
  belegDateiErstellen,
  // Beleg an das PDF eines Vorgangs hängen und seine Seiten zählen (Kontierung, Ablehnung, Aufsplitten, KK-Abgleich;
  // B2, Etappe 4). Ein Fehler (BelegBildFehler, unlesbares PDF/Bild) scheitert wie beim direkten Aufruf.
  belegAnhaengen: belegInPdfAnhaengen,
};
