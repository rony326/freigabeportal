// Vorschaubild (PNG) der ersten PDF-Seite mit mupdf.

import * as mupdf from 'mupdf';

const THUMBNAIL_WIDTH_PX = 200;

// Obergrenze für die Gesamtzahl der je Seite gerasterten Pixel, egal wie das Quell-PDF seine MediaBox angibt. Gleiche Absicherung wie
// MAX_SCAN_PIXELS in qrBillScan.js: Ohne sie lässt ein PDF mit pathologisch schmaler/hoher Seite (hier über nicht vertrauenswürdige
// Anhänge aus POST /n8n/jobs erreichbar) `scale = THUMBNAIL_WIDTH_PX / width` die Höhe entsprechend aufblähen und ein beliebig grosses
// Pixmap im Speicher erzeugen. Ein A4-Thumbnail mit 200 px Breite hat ca. 200 x ~283 ≈ 57'000 px; diese Grenze lässt reichlich Spielraum
// für ungewöhnliche, aber legitime Seitenformen und begrenzt trotzdem den schlimmsten Fall.
const MAX_THUMBNAIL_PIXELS = 2_000_000;

// @param {Buffer} pdfBuffer  @returns {Buffer} PNG (200 px Breite, durch MAX_THUMBNAIL_PIXELS begrenzt); wirft, wenn sich das PDF nicht öffnen lässt
export function renderFirstPageThumbnail(pdfBuffer) {
  let doc;
  try {
    doc = mupdf.Document.openDocument(pdfBuffer, 'application/pdf');
  } catch (err) {
    throw new Error(`PDF konnte für die Thumbnail-Erstellung nicht geöffnet werden: ${err.message}`);
  }
  try {
    const page = doc.loadPage(0);
    try {
      const bounds = page.getBounds();
      const width = bounds[2] - bounds[0];
      const height = bounds[3] - bounds[1];
      let scale = THUMBNAIL_WIDTH_PX / width;
      const scannedPixels = width * scale * (height * scale);
      if (scannedPixels > MAX_THUMBNAIL_PIXELS) {
        scale *= Math.sqrt(MAX_THUMBNAIL_PIXELS / scannedPixels);
      }
      const pixmap = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false);
      try {
        return Buffer.from(pixmap.asPNG());
      } finally {
        pixmap.destroy();
      }
    } finally {
      page.destroy();
    }
  } finally {
    doc.destroy();
  }
}
