import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

export async function buildPdfFixture(pageTexts) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const text of pageTexts) {
    const page = doc.addPage([595, 842]);
    page.drawText(text, { x: 50, y: 800, size: 14, font, color: rgb(0, 0, 0) });
  }
  return Buffer.from(await doc.save());
}
