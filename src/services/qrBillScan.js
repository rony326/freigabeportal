// Liest den Swiss-QR-Code aus dem PDF: Seite rastern (mupdf), QR-Code dekodieren (jsQR) und die Nutzlast parsen (qrBill.js).

import * as mupdf from 'mupdf';
import jsQR from 'jsqr';
import { parseQrBillPayload } from './qrBill.js';

// Deutlich höher als die 200 px Vorschaubreite in thumbnail.js — der Code einer Schweizer QR-Rechnung liegt etwa im unteren linken
// Viertel einer A4-Seite, und jsQR braucht echte Pixelauflösung je Modul, um zuverlässig zu dekodieren, besonders bei gescannten
// (nicht digital erzeugten) Rechnungen.
const SCAN_WIDTH_PX = 1200;

// Obergrenze für die Gesamtzahl Pixel, die dieses Modul je Seite höchstens rastert, egal wie das Quell-PDF seine MediaBox angibt.
// Etwa eine A4-Seite bei SCAN_WIDTH_PX=1200 Breite (1200 x ~1697 ≈ 2,04 Mio. px), mit reichlich Spielraum für breitere/kürzere
// Layouts. Ohne sie lässt `scale = SCAN_WIDTH_PX / width` allein ein PDF mit schmaler/hoher Seite (innerhalb der eigenen Grenzen von
// mupdf zulässig — erreichbar über nicht vertrauenswürdige PDFs aus POST /n8n/jobs) die Höhe entsprechend aufblähen und ein
// beliebig grosses Pixmap erzeugen: gemessen 345 MB / 2,5 s bei einer entarteten [50, 1000]-Seite, bei extremeren Geometrien
// quadratisch schlimmer. Eine so verzerrte Seite rendert ohnehin viel zu klein, als dass jsQR etwas fände; das Begrenzen führt
// also nur dazu, dass scanQrBill seinen ohnehin vorgesehenen Weg "nichts gefunden" (null) nimmt, statt einen unbegrenzten Puffer anzulegen.
const MAX_SCAN_PIXELS = 8_000_000;

// Rastert eine Seite und dekodiert den QR-Code. @returns {string|null} Text des QR-Codes oder null
function decodePageAsQrText(doc, pageIndex) {
  const page = doc.loadPage(pageIndex);
  try {
    const bounds = page.getBounds();
    const width = bounds[2] - bounds[0];
    const height = bounds[3] - bounds[1];
    let scale = SCAN_WIDTH_PX / width;
    const scannedPixels = width * scale * (height * scale);
    if (scannedPixels > MAX_SCAN_PIXELS) {
      scale *= Math.sqrt(MAX_SCAN_PIXELS / scannedPixels);
    }
    // alpha=false, wie in thumbnail.js: unbemalte Seitenfläche kommt als deckendes Weiss zurück. (Eine frühere Version nutzte
    // alpha=true, damit getPixels() für jsQR schon 4-Byte-RGBA liefert — aber mupdf lässt *unbemalte* Pixel eines Pixmaps mit Alpha
    // unkomponiert, d. h. (0,0,0,0), nicht deckendes Weiss. Das macht die vorgeschriebene weisse Ruhezone des QR-Codes in den
    // RGB-Kanälen komplett schwarz, jsQR findet die Positionsmuster nie, und jede Seite wurde still zu null dekodiert. Deckend
    // (alpha=false) zu rendern ergibt einen korrekt weiss hinterlegten RGB-Puffer; den füllen wir unten selbst auf RGBA auf, da
    // jsQR 4 Byte/Pixel verlangt.)
    const pixmap = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false);
    try {
      const rgb = pixmap.getPixels();
      const widthPx = pixmap.getWidth();
      const heightPx = pixmap.getHeight();
      const rgba = new Uint8ClampedArray(widthPx * heightPx * 4);
      for (let src = 0, dst = 0; src < rgb.length; src += 3, dst += 4) {
        rgba[dst] = rgb[src];
        rgba[dst + 1] = rgb[src + 1];
        rgba[dst + 2] = rgb[src + 2];
        rgba[dst + 3] = 255;
      }
      const result = jsQR(rgba, widthPx, heightPx);
      return result ? result.data : null;
    } finally {
      pixmap.destroy();
    }
  } finally {
    page.destroy();
  }
}

/**
 * Sucht den QR-Code auf der ersten (und bei mehreren Seiten der letzten) Seite.
 * @param {Buffer} pdfBuffer
 * @returns {object|null} geparste Zahlungsdaten (siehe parseQrBillPayload) oder null, wenn keiner gefunden wurde
 * @throws {Error} wenn sich das PDF nicht öffnen lässt
 */
export function scanQrBill(pdfBuffer) {
  let doc;
  try {
    doc = mupdf.Document.openDocument(pdfBuffer, 'application/pdf');
  } catch (err) {
    throw new Error(`PDF konnte für die QR-Code-Erkennung nicht geöffnet werden: ${err.message}`);
  }
  try {
    const pageCount = doc.countPages();
    let qrText = decodePageAsQrText(doc, 0);
    if (!qrText && pageCount > 1) {
      qrText = decodePageAsQrText(doc, pageCount - 1);
    }
    if (!qrText) return null;
    return parseQrBillPayload(qrText);
  } finally {
    doc.destroy();
  }
}
