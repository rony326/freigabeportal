// Fehlerklassen der PDF-Verarbeitung ohne mupdf-Abhängigkeit: der Hauptthread kann sie laden und
// aus den Antworten des PDF-Workers wieder aufbauen (services/pdfWorkerPool.js), ohne dafür mupdf
// (WASM, ~55 MB) zu laden. services/pdfEingang.js exportiert PdfEingangFehler, services/belegAnhaengen.js
// BelegBildFehler unverändert weiter.

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

// Ein Bildbeleg, der nicht eingebettet werden darf (zu gross oder nicht lesbar); die Meldung ist für die Person bestimmt.
// `name` ist gesetzt, damit der Fehler über die Worker-Grenze als BelegBildFehler wieder aufgebaut wird.
export class BelegBildFehler extends Error {
  constructor(message) {
    super(message);
    this.name = 'BelegBildFehler';
  }
}
