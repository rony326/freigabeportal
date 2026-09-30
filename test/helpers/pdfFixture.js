import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

export async function buildPdfFixture(pageTexts, { width = 595, height = 842 } = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const text of pageTexts) {
    const page = doc.addPage([width, height]);
    page.drawText(text, { x: 50, y: Math.min(800, height - 42), size: 14, font, color: rgb(0, 0, 0) });
  }
  return Buffer.from(await doc.save());
}

// Seite ohne Textebene (wie ein Scan): lesbar und verarbeitbar, aber ohne extrahierbaren Text.
export async function buildTextlosesPdfFixture() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  page.drawRectangle({ x: 50, y: 600, width: 300, height: 150, color: rgb(0.2, 0.2, 0.2) });
  return Buffer.from(await doc.save());
}

// Echte, mit mupdf verschlüsselte Fassung eines lesbaren PDFs. Ohne userPasswort ist es nur mit
// Besitzerpasswort geschützt (öffnet ohne Passwort, bleibt aber verschlüsselt).
export async function buildVerschluesseltesPdfFixture({ userPasswort = 'geheim' } = {}) {
  const mupdf = await import('mupdf');
  const quelle = await buildPdfFixture(['Verschluesselte Rechnung']);
  const doc = mupdf.Document.openDocument(quelle, 'application/pdf');
  try {
    const optionen = `encrypt=aes-256,owner-password=besitzer${userPasswort ? `,user-password=${userPasswort}` : ''}`;
    return Buffer.from(doc.asPDF().saveToBuffer(optionen).asUint8Array());
  } finally {
    doc.destroy();
  }
}

export async function buildSeitenlosesPdfFixture() {
  return Buffer.from(await (await PDFDocument.create()).save({ addDefaultPage: false }));
}
