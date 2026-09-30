import * as mupdf from 'mupdf';
import { PDFDocument } from 'pdf-lib';

// Eingangsprüfung für PDF-Dokumente, die zu einem regulären Job werden (Rechnungseingang über
// POST /api/n8n/jobs, Spesen-Beleg als Jobdokument). Die Signatur "%PDF" allein sagt nichts über
// die Verarbeitbarkeit: ein Dokument muss sich mit BEIDEN später verwendeten Bibliotheken öffnen
// lassen -- mupdf (Vorschaubild, QR-/Textanalyse) und pdf-lib (Stempel, Beleg-Zusammenführung,
// Splitgruppen) -- mindestens eine Seite haben und die erste Seite muss sich rendern lassen.
//
// Verschlüsselte PDFs werden abgelehnt: mit Benutzerpasswort kann niemand sie lesen, und auch
// "nur" mit Besitzerpasswort geschützte Dokumente kann pdf-lib nicht stempeln (EncryptedPDFError),
// ohne dass der Schutz stillschweigend umgangen würde.
//
// Ein fehlender QR-Code ist kein Fehler -- das prüft diese Funktion bewusst nicht.

export class PdfEingangFehler extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PdfEingangFehler';
    this.code = code;
  }
}

export const PDF_EINGANG_MELDUNGEN = {
  pdf_beschaedigt: 'Die PDF-Datei ist beschädigt oder kein verarbeitbares PDF-Dokument.',
  pdf_verschluesselt: 'Die PDF-Datei ist verschlüsselt bzw. passwortgeschützt. Verschlüsselte PDF-Dateien werden nicht unterstützt; bitte eine ungeschützte Fassung einreichen.',
  pdf_keine_seiten: 'Die PDF-Datei enthält keine lesbare Seite.',
};

function fehler(code) {
  return new PdfEingangFehler(code, PDF_EINGANG_MELDUNGEN[code]);
}

function pruefeMitMupdf(buffer) {
  let doc;
  try {
    doc = mupdf.Document.openDocument(buffer, 'application/pdf');
  } catch {
    throw fehler('pdf_beschaedigt');
  }
  try {
    if (doc.needsPassword()) throw fehler('pdf_verschluesselt');
    let seiten;
    try {
      seiten = doc.countPages();
    } catch {
      throw fehler('pdf_beschaedigt');
    }
    if (!Number.isInteger(seiten) || seiten < 1) throw fehler('pdf_keine_seiten');
    let page;
    try {
      page = doc.loadPage(0);
      const [x0, y0, x1, y1] = page.getBounds();
      if (!(x1 - x0 > 0 && y1 - y0 > 0)) throw fehler('pdf_keine_seiten');
      // Kleine Probe-Rasterung: deckt Seiten auf, deren Inhalt sich nicht verarbeiten lässt.
      const scale = Math.min(1, 50 / (x1 - x0));
      const pixmap = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false);
      pixmap.destroy();
    } catch (err) {
      if (err instanceof PdfEingangFehler) throw err;
      throw fehler('pdf_keine_seiten');
    } finally {
      page?.destroy();
    }
    return seiten;
  } finally {
    doc.destroy();
  }
}

async function pruefeMitPdfLib(buffer) {
  let doc;
  try {
    doc = await PDFDocument.load(Uint8Array.from(buffer), { updateMetadata: false });
  } catch (err) {
    if (err && (err.name === 'EncryptedPDFError' || /encrypted/i.test(err.message))) throw fehler('pdf_verschluesselt');
    throw fehler('pdf_beschaedigt');
  }
  if (doc.isEncrypted) throw fehler('pdf_verschluesselt');
  if (doc.getPageCount() < 1) throw fehler('pdf_keine_seiten');
}

// Wirft PdfEingangFehler (code: pdf_beschaedigt | pdf_verschluesselt | pdf_keine_seiten),
// liefert sonst die Seitenzahl.
export async function pruefeEingangsPdf(buffer) {
  if (!buffer || buffer.length < 5 || buffer.subarray(0, 4).toString('latin1') !== '%PDF') throw fehler('pdf_beschaedigt');
  const seiten = pruefeMitMupdf(buffer);
  await pruefeMitPdfLib(buffer);
  return { seiten };
}
