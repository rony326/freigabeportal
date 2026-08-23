import * as mupdf from 'mupdf';
import jsQR from 'jsqr';
import { parseQrBillPayload } from './qrBill.js';

// Much higher than thumbnail.js's 200px preview width — a Swiss QR-Bill's code occupies roughly
// the bottom-left quarter of an A4 page, and jsQR needs real pixel resolution per module to
// decode reliably, especially for scanned (not born-digital) invoices.
const SCAN_WIDTH_PX = 1200;

// Ceiling on the total number of pixels this module will ever rasterize for one page, regardless
// of how the source PDF declares its MediaBox. Roughly an A4 page rendered at SCAN_WIDTH_PX=1200
// wide (1200 x ~1697 ≈ 2.04M px), with generous headroom for wider/shorter layouts. Without this,
// `scale = SCAN_WIDTH_PX / width` alone lets a PDF with a narrow/tall page (legal within mupdf's
// own limits — this is reachable from untrusted PDFs ingested via POST /n8n/jobs) blow the height
// up to match, producing an arbitrarily large pixmap: measured at 345 MB / 2.5s for a degenerate
// [50, 1000] page, and scaling quadratically worse for more extreme geometries. A page this
// distorted renders far too small for jsQR to find anything anyway, so clamping down to the cap
// just makes scanQrBill take its already-designed "nothing found" (null) path instead of trying
// to allocate an unbounded buffer.
const MAX_SCAN_PIXELS = 8_000_000;

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
    // alpha=false, same as thumbnail.js: unpainted page area comes back as opaque white.
    // (An earlier version of this code used alpha=true so getPixels() would already be
    // 4-bytes/pixel RGBA for jsQR — but mupdf leaves *unpainted* pixels in an alpha-enabled
    // pixmap uncomposited, i.e. (0,0,0,0), not opaque white. That turns the QR code's mandatory
    // white quiet zone into solid black in the RGB channels and jsQR can never find the finder
    // patterns, so every page silently decoded to null. Rendering opaque (alpha=false) instead
    // gives a correctly white-backed RGB buffer; we then pad it out to RGBA ourselves below,
    // since jsQR requires 4 bytes/pixel.)
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
