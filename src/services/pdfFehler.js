// Fehlerklassen der PDF-Verarbeitung ohne mupdf-Abhängigkeit: der Hauptthread kann sie laden und
// aus den Antworten des PDF-Workers wieder aufbauen (services/pdfWorkerPool.js), ohne dafür mupdf
// (WASM, ~55 MB) zu laden. services/pdfEingang.js exportiert PdfEingangFehler unverändert weiter.

// Eingangsprüfung gescheitert (code: pdf_beschaedigt | pdf_verschluesselt | pdf_keine_seiten).
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
