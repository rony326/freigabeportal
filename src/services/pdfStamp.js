import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

function formatZeitpunkt(isoUtc) {
  return new Date(isoUtc).toLocaleString('de-CH', { timeZone: 'Europe/Zurich', dateStyle: 'medium', timeStyle: 'short' });
}

function drawFreigabeBlock(page, font, freigabe, startY) {
  const lines = [
    `${freigabe.name} (${freigabe.identitaet})`,
    `Zeitpunkt: ${formatZeitpunkt(freigabe.zeitpunkt)}`,
    `IP: ${freigabe.ip}`,
    `Interessenskonflikt: ${freigabe.interessenskonflikt ? 'Ja' : 'Nein'}`,
  ];
  if (freigabe.kommentar) {
    lines.push(`Kommentar: ${freigabe.kommentar}`);
  }
  lines.forEach((line, index) => {
    page.drawText(line, { x: 60, y: startY - index * 14, size: 10, font, color: rgb(0, 0, 0) });
  });
}

export async function stampAndFinalize(pdfBuffer, stampData, visumSeitePosition) {
  let doc;
  try {
    doc = await PDFDocument.load(pdfBuffer);
  } catch {
    throw new Error('PDF konnte nicht geladen werden – Datei ist beschädigt oder kein gültiges PDF.');
  }

  const pages = doc.getPages();
  if (pages.length === 0) {
    throw new Error('PDF enthält keine Seiten und kann nicht gestempelt werden.');
  }

  const visumPage = visumSeitePosition === 'erste' ? pages[0] : pages[pages.length - 1];
  const font = await doc.embedFont(StandardFonts.Helvetica);

  drawFreigabeBlock(visumPage, font, stampData.freigeber1, 650);
  drawFreigabeBlock(visumPage, font, stampData.freigeber2, 450);

  return Buffer.from(await doc.save());
}
