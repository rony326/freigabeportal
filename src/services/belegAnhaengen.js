// Beleg anhängen: ein hochgeladener Beleg (PDF, JPG oder PNG) wird als weitere Seiten an das PDF eines Vorgangs gehängt
// (Kontierung, Aufsplitten, Spesen). Bilder werden auf A4 eingepasst. Siehe docs/rechnungs-workflow.md.

import { PDFDocument, PageSizes } from 'pdf-lib';

const A4_HOCH = PageSizes.A4; // [595.28, 841.89] pt
const A4_QUER = [A4_HOCH[1], A4_HOCH[0]];

// Fügt `doc` eine A4-Seite hinzu (Hoch- oder Querformat passend zum Seitenverhältnis der Quelle) und zeichnet `drawable`
// eingepasst und zentriert darauf. Ohne das würde ein Beleg in seiner eigenen Grösse eingebettet — pdf-lib behandelt bei einem
// Foto die rohen Pixelmasse 1:1 als PDF-Punkte, ein 3024x4032-Handyfoto würde also eine Seite von ca. 107x142 cm.
// `draw` abstrahiert page.drawImage (eingebettetes Bild) und page.drawPage (eingebettete PDF-Seite), die dieselbe Optionsform haben.
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

// Prüft die echten Dateikennungs-Bytes, statt dem vom Client angegebenen Content-Type zu trauen — gleiches Vorgehen wie
// detectImageMimetype() in erscheinungsbild.js und isPdf() in n8n/jobs.js, hier kombiniert, weil ein Beleg-Upload beides sein kann.
// @returns {'application/pdf'|'image/png'|'image/jpeg'|null}
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

// embedJpg/embedPng von pdf-lib lesen `bytes.buffer` direkt (das zugrunde liegende ArrayBuffer), ohne byteOffset/byteLength zu
// beachten. Ein kleiner Node-Buffer (z. B. ein winziges hochgeladenes Belegbild) stammt oft aus Nodes gemeinsamem Buffer-Pool,
// dessen `.buffer` weit mehr als nur die eigenen Bytes des Buffers abdeckt — direkt durchgereicht ergibt das Müll ("SOI not found
// in JPEG"), obwohl der Inhalt des Buffers selbst völlig in Ordnung ist. Die Kopie in ein frisches Uint8Array garantiert
// byteOffset 0 und ein ArrayBuffer, das nur diese Daten enthält.
function toOwnedUint8Array(buffer) {
  return Uint8Array.from(buffer);
}

// Liefert, wie viele Seiten ein Beleg nach dem Zusammenführen über mergeBelegInPdf beiträgt — ein PDF-Beleg alle eigenen Seiten,
// ein Bildbeleg immer genau eine. Damit wird die genaue Seitenzahl beim Aufsplitten (kontierung.js) festgehalten, und ein späterer
// Splitgruppen-Merge (splitGruppenExport.js) findet diese Seiten exakt, statt sie aus einer Seitenzahl-Differenz abzuleiten, die ein
// späterer Stempelschritt ungültig machen würde.
export async function countBelegSeiten(belegBuffer, belegMimetype) {
  if (belegMimetype === 'application/pdf') {
    const doc = await PDFDocument.load(toOwnedUint8Array(belegBuffer));
    return doc.getPageCount();
  }
  return 1;
}

// Hängt den Beleg (PDF-Seiten oder Bild) hinter die vorhandenen Seiten des PDFs. @returns {Promise<Buffer>} das neue PDF
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

// Anders als bei mergeBelegInPdf gibt es hier kein vorhandenes Vorgangs-PDF, in das gemergt würde — der Beleg einer Spesenposition
// *ist* das ganze Dokument des Vorgangs. Ein PDF-Beleg wird unverändert zurückgegeben (seine Seiten bleiben unberührt — nur ein in
// ein bestehendes Vorgangs-PDF gemergter Beleg läuft durch die A4-Normalisierung); ein Bildbeleg wird als einzige Seite eines neuen
// PDFs eingebettet und auf A4 eingepasst (gleiche Konvention wie der Bild-Zweig von mergeBelegInPdf).
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
