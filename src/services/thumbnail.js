import * as mupdf from 'mupdf';

const THUMBNAIL_WIDTH_PX = 200;

// Ceiling on the total number of pixels rasterized for one page, regardless of how the source PDF
// declares its MediaBox. Same defense as qrBillScan.js's MAX_SCAN_PIXELS: without it, a PDF with a
// pathological narrow/tall page (reachable here from untrusted attachments ingested via
// POST /n8n/jobs) lets `scale = THUMBNAIL_WIDTH_PX / width` blow the height up to match, producing
// an arbitrarily large in-memory pixmap. A 200px-wide A4 thumbnail is ~200 x ~283 ≈ 57K px; this cap
// gives generous headroom for unusual-but-legitimate page shapes while still bounding worst case.
const MAX_THUMBNAIL_PIXELS = 2_000_000;

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
