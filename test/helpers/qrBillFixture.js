import PDFDocument from 'pdfkit';
import { SwissQRBill } from 'swissqrbill/pdf';

// Real Swiss QR-Bill PDF generator, used only in tests — produces a PDF with a genuine, scannable
// QR code so qrBillScan.js's mupdf+jsQR decode path is exercised against real bytes instead of a
// hand-mocked one. Mirrors the Buffer-returning convention of test/helpers/pdfFixture.js.
export async function buildQrBillPdfFixture(data, { onDocument } = {}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4' });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    if (onDocument) onDocument(doc);
    new SwissQRBill(data).attachTo(doc);
    doc.end();
  });
}
