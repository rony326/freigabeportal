import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const VERLAUF_LINE_HEIGHT = 14;
const VERLAUF_BOTTOM_MARGIN = 40;
const PAGE_MARGIN = 100; // 60pt left draw origin + 40pt right margin
const BLOCK_HEADING_GAP = 18;
const BLOCK_GAP = 30;

function formatZeitpunkt(isoUtc) {
  return new Date(isoUtc).toLocaleString('de-CH', { timeZone: 'Europe/Zurich', dateStyle: 'medium', timeStyle: 'short' });
}

// Greedily wraps `text` into lines that each fit within `maxWidth` at `size` for `font`, so
// long free-text fields (rejection reasons, comments) never render partially or fully outside
// the page's MediaBox — pdf-lib's drawText() does not wrap or clip on its own.
function wrapLine(font, text, size, maxWidth) {
  const words = text.split(' ');
  const lines = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (current && font.widthOfTextAtSize(candidate, size) > maxWidth) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

// Draws a heading plus the Freigabe's fields starting at `startY`, and returns the y position
// right after the last drawn line — the caller stacks blocks by feeding that back in as the
// next block's startY, rather than relying on fixed, unrelated-to-content offsets.
function drawFreigabeBlock(page, font, heading, freigabe, startY, maxWidth) {
  let y = startY;
  page.drawText(heading, { x: 60, y, size: 11, font, color: rgb(0, 0, 0) });
  y -= BLOCK_HEADING_GAP;

  const lines = [
    `${freigabe.name} (${freigabe.identitaet})`,
    `Zeitpunkt: ${formatZeitpunkt(freigabe.zeitpunkt)}`,
    `IP: ${freigabe.ip}`,
    `Interessenskonflikt: ${freigabe.interessenskonflikt ? 'Ja' : 'Nein'}`,
  ];
  if (freigabe.kommentar) {
    lines.push(`Kommentar: ${freigabe.kommentar}`);
  }
  for (const line of lines) {
    for (const wrapped of wrapLine(font, line, 10, maxWidth)) {
      page.drawText(wrapped, { x: 60, y, size: 10, font, color: rgb(0, 0, 0) });
      y -= 14;
    }
  }
  return y;
}

function verlaufEntryLines(entry) {
  const lines = [
    `${formatZeitpunkt(entry.zeitpunkt)} — ${entry.rolleLabel} — ${entry.name} (${entry.identitaet})${entry.interessenskonflikt ? ' [Interessenskonflikt]' : ''}`,
  ];
  if (entry.kommentar) {
    lines.push(`   Kommentar: ${entry.kommentar}`);
  }
  return lines;
}

// Draws the Verlauf heading and every entry starting at (page, startY), overflowing onto freshly
// appended same-size pages whenever a line would fall below VERLAUF_BOTTOM_MARGIN.
function drawVerlauf(doc, font, verlauf, page, startY, pageWidth, pageHeight) {
  const maxWidth = pageWidth - PAGE_MARGIN;
  const allLines = verlauf.flatMap((entry) =>
    verlaufEntryLines(entry).flatMap((line) => wrapLine(font, line, 9, maxWidth))
  );

  let currentPage = page;
  let y = startY;
  currentPage.drawText('Verlauf', { x: 60, y: y + 20, size: 12, font, color: rgb(0, 0, 0) });

  for (const line of allLines) {
    if (y < VERLAUF_BOTTOM_MARGIN) {
      currentPage = doc.addPage([pageWidth, pageHeight]);
      y = pageHeight - 50;
      currentPage.drawText('Verlauf (Fortsetzung)', { x: 60, y: y + 20, size: 12, font, color: rgb(0, 0, 0) });
    }
    currentPage.drawText(line, { x: 60, y, size: 9, font, color: rgb(0, 0, 0) });
    y -= VERLAUF_LINE_HEIGHT;
  }
}

// Appends one new page to the PDF itself — carrying both Freigaben (top) and the full audit-log
// Verlauf (below, continuing onto further appended pages if it doesn't fit) — instead of relying
// on a blank "Visum" page n8n pre-merged into the document before upload. The stamped page is
// always the last one; there is no longer a position to choose.
export async function stampAndFinalize(pdfBuffer, stampData) {
  let doc;
  try {
    doc = await PDFDocument.load(pdfBuffer);
  } catch {
    throw new Error('PDF konnte nicht geladen werden – Datei ist beschädigt oder kein gültiges PDF.');
  }

  // Everything below is guarded by a single catch: pdf-lib's load() parses leniently and can
  // succeed on a file that is not really usable (e.g. only a "%PDF" header with garbage after
  // it), with the real failure only surfacing on getPages()/save(). Text drawn with the
  // Helvetica standard font is also limited to WinAnsi and throws if any of the stamped or
  // Verlauf text contains characters outside that set (emoji, Cyrillic, Greek, ...).
  // All of these are "this PDF could not be stamped" to a caller, so they share one
  // German-language error rather than leaking pdf-lib's raw English exception.
  try {
    const pages = doc.getPages();
    if (pages.length === 0) {
      throw new Error('PDF enthält keine Seiten und kann nicht gestempelt werden.');
    }

    // New page reuses the size of the document's existing last page for visual consistency with
    // the rest of the file, rather than assuming a fixed standard size.
    const { width, height } = pages[pages.length - 1].getSize();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const boldFont = await doc.embedFont(StandardFonts.HelveticaBold);
    const maxWidth = width - PAGE_MARGIN;

    const stampPage = doc.addPage([width, height]);
    let y = height - 50;
    if (stampData.jobId != null) {
      stampPage.drawText(`Job-ID: ${stampData.jobId}`, { x: 60, y, size: 14, font: boldFont, color: rgb(0, 0, 0) });
      y -= 30;
    }
    if (stampData.konto) {
      for (const line of wrapLine(boldFont, `Konto: ${stampData.konto.nummer} — ${stampData.konto.bezeichnung}`, 14, maxWidth)) {
        stampPage.drawText(line, { x: 60, y, size: 14, font: boldFont, color: rgb(0, 0, 0) });
        y -= 18;
      }
      y -= 12;
    }
    // Only ever populated for a Spesen position (see freigabe2.js) — same prominence/style as the
    // Konto line above, since Titel/Verwendungszweck are what identify the document (a Spesen
    // position has no separate Rechnungsnummer/Lieferant to serve that purpose).
    if (stampData.titel) {
      for (const line of wrapLine(boldFont, `Titel: ${stampData.titel}`, 14, maxWidth)) {
        stampPage.drawText(line, { x: 60, y, size: 14, font: boldFont, color: rgb(0, 0, 0) });
        y -= 18;
      }
      y -= 12;
    }
    if (stampData.verwendungszweck) {
      for (const line of wrapLine(boldFont, `Verwendungszweck: ${stampData.verwendungszweck}`, 14, maxWidth)) {
        stampPage.drawText(line, { x: 60, y, size: 14, font: boldFont, color: rgb(0, 0, 0) });
        y -= 18;
      }
      y -= 12;
    }
    // Only ever populated for a Spesen position (see freigabe2.js) — the account the
    // reimbursement is actually paid to, so it's visible on the document itself and not only in
    // the n8n/Paperless API response, which was the whole point of asking for it here.
    if (stampData.zahlungsdaten && (stampData.zahlungsdaten.iban || stampData.zahlungsdaten.kontoinhaber)) {
      stampPage.drawText('Zahlungsdaten', { x: 60, y, size: 11, font: boldFont, color: rgb(0, 0, 0) });
      y -= BLOCK_HEADING_GAP;
      const zahlungsdatenLines = [];
      if (stampData.zahlungsdaten.kontoinhaber) zahlungsdatenLines.push(`Kontoinhaber: ${stampData.zahlungsdaten.kontoinhaber}`);
      if (stampData.zahlungsdaten.iban) zahlungsdatenLines.push(`IBAN: ${stampData.zahlungsdaten.iban}`);
      for (const line of zahlungsdatenLines) {
        for (const wrapped of wrapLine(font, line, 10, maxWidth)) {
          stampPage.drawText(wrapped, { x: 60, y, size: 10, font, color: rgb(0, 0, 0) });
          y -= 14;
        }
      }
      y -= BLOCK_GAP;
    }
    y = drawFreigabeBlock(stampPage, font, 'Freigabe 1', stampData.freigeber1, y, maxWidth);
    y -= BLOCK_GAP;
    y = drawFreigabeBlock(stampPage, font, 'Freigabe 2', stampData.freigeber2, y, maxWidth);
    y -= BLOCK_GAP;
    drawVerlauf(doc, font, stampData.verlauf, stampPage, y, width, height);

    return Buffer.from(await doc.save());
  } catch {
    throw new Error('PDF konnte nicht gestempelt werden – Dokument ist ungültig oder enthält Zeichen, die nicht dargestellt werden können.');
  }
}

// Combined stamp page for a Splitgruppe: one Konto/Betrag/Position/Freigabe-1+2 block per split
// line instead of stampAndFinalize's single Konto block, plus one shared Verlauf covering every
// child's freigaben (caller pre-sorts/pre-labels it, see splitGruppenExport.js). Reuses
// drawFreigabeBlock/drawVerlauf/wrapLine verbatim -- only the loop over multiple Positionen is new.
export async function stampGruppenDokument(pdfBuffer, gruppenData) {
  let doc;
  try {
    doc = await PDFDocument.load(pdfBuffer);
  } catch {
    throw new Error('PDF konnte nicht geladen werden – Datei ist beschädigt oder kein gültiges PDF.');
  }

  try {
    const pages = doc.getPages();
    if (pages.length === 0) {
      throw new Error('PDF enthält keine Seiten und kann nicht gestempelt werden.');
    }

    const { width, height } = pages[pages.length - 1].getSize();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const boldFont = await doc.embedFont(StandardFonts.HelveticaBold);
    const maxWidth = width - PAGE_MARGIN;
    const TITLE_BOTTOM_MARGIN = 80; // room for up to ~2 wrapped title lines
    const FREIGABE_BLOCK_BOTTOM_MARGIN = 130; // heading(18) + up to 5 lines(14 each, with a Kommentar) = 88, plus headroom

    let stampPage = doc.addPage([width, height]);
    let y = height - 50;
    if (gruppenData.jobId != null) {
      stampPage.drawText(`Splitgruppe — Job-ID: ${gruppenData.jobId}`, { x: 60, y, size: 14, font: boldFont, color: rgb(0, 0, 0) });
      y -= 30;
    }

    for (const position of gruppenData.positionen) {
      if (y < TITLE_BOTTOM_MARGIN) {
        stampPage = doc.addPage([width, height]);
        y = height - 50;
      }
      const titelTeile = [`Konto: ${position.kontoNummer} — ${position.kontoBezeichnung}`, `Betrag: ${position.betrag}`];
      if (position.position) titelTeile.push(`Position: ${position.position}`);
      for (const line of wrapLine(boldFont, titelTeile.join(' — '), 13, maxWidth)) {
        stampPage.drawText(line, { x: 60, y, size: 13, font: boldFont, color: rgb(0, 0, 0) });
        y -= 17;
      }
      y -= 10;
      if (y < FREIGABE_BLOCK_BOTTOM_MARGIN) {
        stampPage = doc.addPage([width, height]);
        y = height - 50;
      }
      y = drawFreigabeBlock(stampPage, font, 'Freigabe 1', position.freigeber1, y, maxWidth);
      y -= BLOCK_GAP;
      if (y < FREIGABE_BLOCK_BOTTOM_MARGIN) {
        stampPage = doc.addPage([width, height]);
        y = height - 50;
      }
      y = drawFreigabeBlock(stampPage, font, 'Freigabe 2', position.freigeber2, y, maxWidth);
      y -= BLOCK_GAP + 10;
    }

    if (y < VERLAUF_BOTTOM_MARGIN + 20) {
      stampPage = doc.addPage([width, height]);
      y = height - 50;
    }
    drawVerlauf(doc, font, gruppenData.verlauf, stampPage, y, width, height);

    return Buffer.from(await doc.save());
  } catch {
    throw new Error('PDF konnte nicht gestempelt werden – Dokument ist ungültig oder enthält Zeichen, die nicht dargestellt werden können.');
  }
}
