import * as mupdf from 'mupdf';

const THUMBNAIL_WIDTH_PX = 200;

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
      const scale = THUMBNAIL_WIDTH_PX / width;
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
