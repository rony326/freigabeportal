// Beleg anhängen: ein hochgeladener Beleg (PDF, JPG oder PNG) wird als weitere Seiten an das PDF eines Vorgangs gehängt
// (Kontierung, Aufsplitten, Spesen). Bilder werden auf A4 eingepasst. Siehe docs/rechnungs-workflow.md.

import { PDFDocument, PageSizes } from 'pdf-lib';
import { BelegBildFehler } from './pdfFehler.js';

const A4_HOCH = PageSizes.A4; // [595.28, 841.89] pt
const A4_QUER = [A4_HOCH[1], A4_HOCH[0]];

// Obergrenze für Bildbelege in Megapixeln. Die Dateigrösse sagt nichts über den Speicherbedarf beim Dekodieren: ein hoch
// komprimiertes PNG von 186 KB mit 14000 x 14000 Pixeln belegt rund 840 MB und blockiert den Prozess ca. 20 Sekunden.
export const MAX_BILD_MEGAPIXEL = 40;

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

// Liest Breite und Höhe aus dem Bildkopf, ohne das Bild zu dekodieren. PNG: IHDR-Chunk direkt nach der Signatur. JPEG: erster
// SOF-Marker (SOF0–SOF15 ausser DHT 0xC4, JPG 0xC8, DAC 0xCC); die Segmente davor werden über ihre Längenangabe übersprungen.
// @returns {{breite: number, hoehe: number}|null} null, wenn der Kopf abgeschnitten oder kaputt ist
function leseBildMasse(buffer, mimetype) {
  if (mimetype === 'image/png') {
    if (buffer.length < 24 || buffer.toString('ascii', 12, 16) !== 'IHDR') return null;
    return { breite: buffer.readUInt32BE(16), hoehe: buffer.readUInt32BE(20) };
  }
  let pos = 2; // hinter SOI
  while (pos + 4 <= buffer.length) {
    if (buffer[pos] !== 0xff) return null;
    const marker = buffer[pos + 1];
    if (marker === 0xff) { pos += 1; continue; } // Füllbytes
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { pos += 2; continue; } // ohne Länge
    if (marker === 0xd9 || marker === 0xda) return null; // Ende bzw. Bilddaten vor einem SOF: kein Kopf gefunden
    const laenge = buffer.readUInt16BE(pos + 2);
    if (laenge < 2) return null;
    const istSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (istSof) {
      if (laenge < 8 || pos + 9 > buffer.length) return null;
      return { hoehe: buffer.readUInt16BE(pos + 5), breite: buffer.readUInt16BE(pos + 7) };
    }
    pos += 2 + laenge;
  }
  return null;
}

// Prüft einen Bildbeleg vor dem Einbetten anhand des Bildkopfs (siehe MAX_BILD_MEGAPIXEL). Ein Bild, dessen Masse sich nicht
// bestimmen lassen, wird ebenfalls abgelehnt: es ginge sonst ungeprüft an embedPng/embedJpg. PDFs sind nicht betroffen.
// @returns {string|null} verständliche Fehlermeldung für die Person, oder null wenn der Beleg in Ordnung ist
export function pruefeBelegBild(buffer, mimetype) {
  if (mimetype !== 'image/png' && mimetype !== 'image/jpeg') return null;
  const masse = leseBildMasse(buffer, mimetype);
  if (!masse || masse.breite < 1 || masse.hoehe < 1) {
    return 'Das Bild konnte nicht gelesen werden. Bitte lade eine andere Datei hoch oder fotografiere den Beleg neu.';
  }
  if (masse.breite * masse.hoehe > MAX_BILD_MEGAPIXEL * 1_000_000) {
    return `Das Bild ist zu gross (${masse.breite} × ${masse.hoehe} Pixel). Erlaubt sind höchstens ${MAX_BILD_MEGAPIXEL} Megapixel. Bitte verkleinere das Bild oder lade stattdessen ein PDF hoch.`;
  }
  return null;
}

// Wie pruefeBelegBild, wirft aber — zur Absicherung der Stellen, die Bilder tatsächlich einbetten.
function stelleBildGroesseSicher(buffer, mimetype) {
  const fehler = pruefeBelegBild(buffer, mimetype);
  if (fehler) throw new BelegBildFehler(fehler);
}

// Ein Bildbeleg, der nicht eingebettet werden darf (zu gross oder nicht lesbar); liegt ohne pdf-lib in pdfFehler.js,
// damit der Hauptthread ihn aus Antworten des PDF-Workers wieder aufbauen kann.
export { BelegBildFehler };

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
  stelleBildGroesseSicher(belegBuffer, belegMimetype);
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
  stelleBildGroesseSicher(belegBuffer, belegMimetype);
  const doc = await PDFDocument.create();
  const image = belegMimetype === 'image/png' ? await doc.embedPng(belegBytes) : await doc.embedJpg(belegBytes);
  fuegeBelegSeiteAlsA4Hinzu(doc, image, image.width, image.height, (page, img, opts) => page.drawImage(img, opts));
  return Buffer.from(await doc.save());
}
