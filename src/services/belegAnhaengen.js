import { PDFDocument, PageSizes } from 'pdf-lib';

const A4_HOCH = PageSizes.A4; // [595.28, 841.89] pt
const A4_QUER = [A4_HOCH[1], A4_HOCH[0]];

// Adds one A4 page to `doc` (portrait or landscape, matching the source's own aspect ratio) and
// draws `drawable` onto it scaled to fit and centered. Without this, a Beleg gets embedded at its
// native size — for a photo, pdf-lib treats raw pixel dimensions as PDF points 1:1, so e.g. a
// 3024x4032 phone photo becomes a ~42x56 inch page. `draw` abstracts over page.drawImage (for an
// embedded image) vs. page.drawPage (for an embedded PDF page), which take the same options shape.
function fuegeBelegSeiteAlsA4Hinzu(doc, drawable, sourceWidth, sourceHeight, draw) {
  const istQuer = sourceWidth > sourceHeight;
  const [pageWidth, pageHeight] = istQuer ? A4_QUER : A4_HOCH;
  const scale = Math.min(pageWidth / sourceWidth, pageHeight / sourceHeight);
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;
  const page = doc.addPage([pageWidth, pageHeight]);
  draw(page, drawable, { x: (pageWidth - width) / 2, y: (pageHeight - height) / 2, width, height });
  return page;
}

// Sniffs real file-signature bytes rather than trusting the client-declared Content-Type — same
// approach as detectImageMimetype() in erscheinungsbild.js and isPdf() in n8n/jobs.js, combined
// here since a Beleg upload may be either kind.
export function detectBelegMimetype(buffer) {
  if (buffer.length >= 4 && buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) {
    return 'application/pdf';
  }
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  return null;
}

// pdf-lib's embedJpg/embedPng read `bytes.buffer` directly (the underlying ArrayBuffer), rather
// than respecting byteOffset/byteLength. A small Node Buffer (e.g. a tiny uploaded Beleg image)
// is often allocated from Node's shared Buffer pool, whose `.buffer` covers far more than just
// that Buffer's own bytes — so passing it straight through resolves to garbage ("SOI not found in
// JPEG") even though the Buffer's own contents are perfectly valid. Copying into a fresh
// Uint8Array guarantees byteOffset 0 and an ArrayBuffer containing only this data.
function toOwnedUint8Array(buffer) {
  return Uint8Array.from(buffer);
}

// Returns how many pages a Beleg will contribute once merged via mergeBelegInPdf — a PDF
// Beleg contributes all of its own pages, an image Beleg always contributes exactly one. Used
// to record the exact page count at Aufsplitten time (kontierung.js) so a later Splitgruppen
// merge (splitGruppenExport.js) can locate those pages precisely instead of re-deriving them
// from a page-count delta that a subsequent stamping step would invalidate.
export async function countBelegSeiten(belegBuffer, belegMimetype) {
  if (belegMimetype === 'application/pdf') {
    const doc = await PDFDocument.load(toOwnedUint8Array(belegBuffer));
    return doc.getPageCount();
  }
  return 1;
}

export async function mergeBelegInPdf(pdfBuffer, belegBuffer, belegMimetype) {
  const doc = await PDFDocument.load(toOwnedUint8Array(pdfBuffer));
  const belegBytes = toOwnedUint8Array(belegBuffer);

  if (belegMimetype === 'application/pdf') {
    const belegDoc = await PDFDocument.load(belegBytes);
    const embeddedPages = await doc.embedPdf(belegDoc, belegDoc.getPageIndices());
    embeddedPages.forEach((embeddedPage) => {
      fuegeBelegSeiteAlsA4Hinzu(doc, embeddedPage, embeddedPage.width, embeddedPage.height, (page, img, opts) =>
        page.drawPage(img, opts)
      );
    });
  } else {
    const image = belegMimetype === 'image/png' ? await doc.embedPng(belegBytes) : await doc.embedJpg(belegBytes);
    fuegeBelegSeiteAlsA4Hinzu(doc, image, image.width, image.height, (page, img, opts) => page.drawImage(img, opts));
  }

  return Buffer.from(await doc.save());
}

// Unlike mergeBelegInPdf, there is no existing job PDF to merge into here — a Spesen position's
// Beleg *is* the entire job document. A PDF Beleg is returned as-is (its own pages are left
// untouched — only a Beleg merged into an existing job PDF goes through the A4 normalization); an
// image Beleg is embedded as the sole page of a brand-new PDF, fitted to A4 (same convention
// mergeBelegInPdf's image branch already uses for a merged image page).
export async function buildBelegPdf(belegBuffer, belegMimetype) {
  const belegBytes = toOwnedUint8Array(belegBuffer);
  if (belegMimetype === 'application/pdf') {
    return Buffer.from(belegBytes);
  }
  const doc = await PDFDocument.create();
  const image = belegMimetype === 'image/png' ? await doc.embedPng(belegBytes) : await doc.embedJpg(belegBytes);
  fuegeBelegSeiteAlsA4Hinzu(doc, image, image.width, image.height, (page, img, opts) => page.drawImage(img, opts));
  return Buffer.from(await doc.save());
}
