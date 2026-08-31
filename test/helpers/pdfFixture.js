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
