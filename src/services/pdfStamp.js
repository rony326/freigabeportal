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

  // Everything below is guarded by a single catch: pdf-lib's load() parses leniently and can
  // succeed on a file that is not really usable (e.g. only a "%PDF" header with garbage after
  // it), with the real failure only surfacing on getPages()/save(). Text drawn with the
  // Helvetica standard font is also limited to WinAnsi and throws if freigabe.name or
  // freigabe.kommentar contain characters outside that set (emoji, Cyrillic, Greek, ...).
  // All of these are "this PDF could not be stamped" to a caller, so they share one
  // German-language error rather than leaking pdf-lib's raw English exception.
  try {
    const pages = doc.getPages();
    if (pages.length === 0) {
      throw new Error('PDF enthält keine Seiten und kann nicht gestempelt werden.');
    }

    const visumPage = visumSeitePosition === 'erste' ? pages[0] : pages[pages.length - 1];
    const font = await doc.embedFont(StandardFonts.Helvetica);

    drawFreigabeBlock(visumPage, font, stampData.freigeber1, 650);
    drawFreigabeBlock(visumPage, font, stampData.freigeber2, 450);

    return Buffer.from(await doc.save());
  } catch {
    throw new Error('PDF konnte nicht gestempelt werden – Dokument ist ungültig oder enthält Zeichen, die nicht dargestellt werden können.');
  }
}
