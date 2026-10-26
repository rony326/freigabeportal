import { PDFDocument, StandardFonts, rgb, PageSizes } from 'pdf-lib';

const [STAMP_WIDTH, STAMP_HEIGHT] = PageSizes.A4;
const VERLAUF_LINE_HEIGHT = 14;
const VERLAUF_BOTTOM_MARGIN = 40;
const PAGE_MARGIN = 100; // 60pt left draw origin + 40pt right margin
const BLOCK_HEADING_GAP = 18;
const BLOCK_GAP = 30;

function formatZeitpunkt(isoUtc) {
  return new Date(isoUtc).toLocaleString('de-CH', { timeZone: 'Europe/Zurich', dateStyle: 'medium', timeStyle: 'short' });
}

// Kommentarzeilen: TT.MM.JJJJ HH:MM (Europe/Zurich), per formatToParts unabhängig von den
// installierten Intl-Locale-Daten -- gleiches Format wie zeitpunktAnzeige (auditLog.js).
function formatKommentarZeitpunkt(iso) {
  const datum = new Date(iso);
  if (!iso || Number.isNaN(datum.getTime())) return String(iso ?? '');
  const teile = Object.fromEntries(new Intl.DateTimeFormat('de-CH', {
    timeZone: 'Europe/Zurich', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(datum).map((t) => [t.type, t.value]));
  return `${teile.day}.${teile.month}.${teile.year} ${teile.hour}:${teile.minute}`;
}

// Was Helvetica (WinAnsiEncoding) in pdf-lib darstellen kann: druckbares ASCII, Latin-1 ab NBSP
// und die cp1252-Zusatzzeichen (€, Gedankenstriche, typografische Anführungszeichen, ...).
const WINANSI_ZUSATZ = new Set([
  0x152, 0x153, 0x160, 0x161, 0x178, 0x17d, 0x17e, 0x192, 0x2c6, 0x2dc, 0x2013, 0x2014, 0x2018, 0x2019,
  0x201a, 0x201c, 0x201d, 0x201e, 0x2020, 0x2021, 0x2022, 0x2026, 0x2030, 0x2039, 0x203a, 0x20ac, 0x2122,
]);

function istWinAnsi(codePoint) {
  return (codePoint >= 0x20 && codePoint <= 0x7e) || (codePoint >= 0xa0 && codePoint <= 0xff) || WINANSI_ZUSATZ.has(codePoint);
}

const GRAPHEME = new Intl.Segmenter('de', { granularity: 'grapheme' });

// Macht beliebigen Text stempelbar: Zeilenumbrüche (\r\n, \r) werden zu \n vereinheitlicht und
// bleiben erhalten, Tabs werden zu Leerzeichen, alles andere, was die Standardschrift nicht
// kodieren kann (Emoji, Kyrillisch, Steuerzeichen, ...), wird zu "?" -- ein "?" pro sichtbarem
// Zeichen (Graphem), also auch bei ZWJ-Emoji, Flaggen und Variantenselektoren nur eins.
// NFC zuerst, damit zerlegte Umlaute (a + U+0308) als "ä" erhalten bleiben.
export function winAnsiSicher(text) {
  const normalisiert = String(text ?? '').normalize('NFC').replace(/\r\n?/g, '\n').replace(/\t/g, ' ');
  let ergebnis = '';
  for (const { segment } of GRAPHEME.segment(normalisiert)) {
    const darstellbar = segment === '\n' || [...segment].every((zeichen) => istWinAnsi(zeichen.codePointAt(0)));
    ergebnis += darstellbar ? segment : '?';
  }
  return ergebnis;
}

// Für einzeilige Felder (Namen, Titel, Verlauf-Kommentar): Umbrüche werden zu Leerzeichen, weil
// drawText() keinen Zeilenumbruch kodieren kann.
function einzeilig(text) {
  return winAnsiSicher(text).replace(/\n/g, ' ');
}

// Greedily wraps `text` into lines that each fit within `maxWidth` at `size` for `font`, so
// long free-text fields (rejection reasons, comments) never render partially or fully outside
// the page's MediaBox — pdf-lib's drawText() does not wrap or clip on its own.
function wrapLine(font, text, size, maxWidth) {
  const words = text.split(' ').flatMap((word) => zerlegeLangesWort(font, word, size, maxWidth));
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

// Ein einzelnes Wort, das breiter als die Zeile ist (z. B. eine lange URL oder 2000 Zeichen ohne
// Leerzeichen), wird hart in zeilenbreite Stücke zerlegt -- sonst liefe es rechts aus der Seite.
function zerlegeLangesWort(font, word, size, maxWidth) {
  if (font.widthOfTextAtSize(word, size) <= maxWidth) return [word];
  const teile = [];
  let current = '';
  for (const zeichen of word) {
    if (current && font.widthOfTextAtSize(current + zeichen, size) > maxWidth) {
      teile.push(current);
      current = zeichen;
    } else {
      current += zeichen;
    }
  }
  if (current) teile.push(current);
  return teile;
}

// Draws a heading plus the Freigabe's fields starting at `startY`, and returns the y position
// right after the last drawn line — the caller stacks blocks by feeding that back in as the
// next block's startY, rather than relying on fixed, unrelated-to-content offsets.
function drawFreigabeBlock(page, font, heading, freigabe, startY, maxWidth) {
  let y = startY;
  page.drawText(heading, { x: 60, y, size: 11, font, color: rgb(0, 0, 0) });
  y -= BLOCK_HEADING_GAP;

  const lines = [
    `${einzeilig(freigabe.name)} (${freigabe.identitaet})`,
    `Zeitpunkt: ${formatZeitpunkt(freigabe.zeitpunkt)}`,
    `IP: ${freigabe.ip}`,
    `Interessenskonflikt: ${freigabe.interessenskonflikt ? 'Ja' : 'Nein'}`,
  ];
  if (freigabe.kommentar) {
    lines.push(`Kommentar: ${einzeilig(freigabe.kommentar)}`);
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
    `${formatZeitpunkt(entry.zeitpunkt)} — ${entry.rolleLabel} — ${einzeilig(entry.name)} (${entry.identitaet})${entry.interessenskonflikt ? ' [Interessenskonflikt]' : ''}`,
  ];
  if (entry.kommentar) {
    lines.push(`   Kommentar: ${einzeilig(entry.kommentar)}`);
  }
  return lines;
}

// Draws a section heading and its lines starting at (page, startY), overflowing onto freshly
// appended same-size pages (with "<Titel> (Fortsetzung)") whenever a line would fall below
// VERLAUF_BOTTOM_MARGIN. Each line is { text, x, font, halte }; `halte` = so viele folgende Zeilen
// müssen noch mit auf die Seite (Überschrift/Kopfzeile nie allein am Seitenende). Returns where
// drawing stopped so a following section can continue right below.
function drawAbschnitt(doc, font, titel, lines, page, startY, pageWidth, pageHeight) {
  let currentPage = page;
  let y = startY;
  currentPage.drawText(titel, { x: 60, y: y + 20, size: 12, font, color: rgb(0, 0, 0) });

  for (const line of lines) {
    if (y - (line.halte ?? 0) * VERLAUF_LINE_HEIGHT < VERLAUF_BOTTOM_MARGIN) {
      currentPage = doc.addPage([pageWidth, pageHeight]);
      y = pageHeight - 50;
      currentPage.drawText(`${titel} (Fortsetzung)`, { x: 60, y: y + 20, size: 12, font, color: rgb(0, 0, 0) });
    }
    if (line.text) currentPage.drawText(line.text, { x: line.x ?? 60, y, size: 9, font: line.font ?? font, color: rgb(0, 0, 0) });
    y -= VERLAUF_LINE_HEIGHT;
  }
  return { page: currentPage, y };
}

function drawVerlauf(doc, font, verlauf, page, startY, pageWidth, pageHeight) {
  const maxWidth = pageWidth - PAGE_MARGIN;
  const allLines = verlauf.flatMap((entry) =>
    verlaufEntryLines(entry).flatMap((line) => wrapLine(font, line, 9, maxWidth).map((text) => ({ text })))
  );
  return drawAbschnitt(doc, font, 'Verlauf', allLines, page, startY, pageWidth, pageHeight);
}

export const KOMMENTAR_ABSCHNITT_TITEL = 'Rückfragen und Kommentare';
const KOMMENTAR_EINZUG = 12;

// Markiert die erste von `anzahl` zusammengehörigen Zeilen so, dass sie samt den übrigen und
// `danach` weiteren Zeilen auf derselben Seite beginnt.
function halteZusammen(zeilen, danach) {
  if (zeilen.length) zeilen[0] = { ...zeilen[0], halte: zeilen.length - 1 + danach };
  return zeilen;
}

// Je Kommentar eine Kopfzeile "<TT.MM.JJJJ HH:MM> — <Verfasser>:", darunter der Text (eingerückt,
// Zeilenumbrüche des Originals bleiben eigene Zeilen), dann eine Leerzeile. Die Kopfzeile steht
// immer mit der ersten Textzeile auf derselben Seite.
function kommentarZeilen(font, kommentare, maxWidth) {
  const zeilen = [];
  for (const kommentar of kommentare) {
    const kopf = `${formatKommentarZeitpunkt(kommentar.zeitpunkt)} — ${einzeilig(kommentar.verfasser)}:`;
    zeilen.push(...halteZusammen(wrapLine(font, kopf, 9, maxWidth).map((text) => ({ text })), 1));
    for (const absatz of winAnsiSicher(kommentar.text).split('\n')) {
      const umbrochen = wrapLine(font, absatz, 9, maxWidth - KOMMENTAR_EINZUG);
      if (umbrochen.length === 0) zeilen.push({ text: '' });
      for (const text of umbrochen) zeilen.push({ text, x: 60 + KOMMENTAR_EINZUG });
    }
    zeilen.push({ text: '' });
  }
  return zeilen;
}

// Abschnitt "Rückfragen und Kommentare" direkt unter dem Verlauf; ohne Kommentare kein Abschnitt
// (und damit keine zusätzliche Seite). `gruppen` = [{ untertitel, kommentare }].
function drawKommentare(doc, font, boldFont, gruppen, fortsetzung, pageWidth, pageHeight) {
  const maxWidth = pageWidth - PAGE_MARGIN;
  const zeilen = [];
  for (const { untertitel, kommentare } of gruppen) {
    if (!kommentare?.length) continue;
    const kommentarTeil = kommentarZeilen(font, kommentare, maxWidth);
    if (untertitel) {
      // Untertitel samt Kopfzeile(n) und erster Textzeile des ersten Kommentars zusammenhalten.
      const kopfUndErsteZeile = (kommentarTeil[0].halte ?? 0) + 1;
      zeilen.push(...halteZusammen(wrapLine(boldFont, einzeilig(untertitel), 9, maxWidth).map((text) => ({ text, font: boldFont })), kopfUndErsteZeile));
    }
    zeilen.push(...kommentarTeil);
  }
  if (zeilen.length === 0) return;
  let { page, y } = fortsetzung;
  y -= BLOCK_GAP;
  // Titel (y + 20) plus der erste zusammengehörige Zeilenblock müssen noch auf die Seite passen --
  // sonst stünde der Titel allein am Seitenende.
  if (y - (zeilen[0].halte ?? 0) * VERLAUF_LINE_HEIGHT < VERLAUF_BOTTOM_MARGIN + VERLAUF_LINE_HEIGHT) {
    page = doc.addPage([pageWidth, pageHeight]);
    y = pageHeight - 50;
  }
  drawAbschnitt(doc, font, KOMMENTAR_ABSCHNITT_TITEL, zeilen, page, y, pageWidth, pageHeight);
}

// Nur in der Test-Instanz (config.testmodus): Stempelseiten der Spielwiese sehen sonst aus wie eine
// echte Freigabe. Die echte App setzt das Flag nie, ihre Stempelseite bleibt unverändert.
export const TESTMODUS_MARKE = 'TESTMODUS – keine echte Freigabe';

function zeichneTestmodusMarke(page, boldFont, font, y) {
  const rot = rgb(0.75, 0, 0);
  page.drawText(TESTMODUS_MARKE, { x: 60, y, size: 18, font: boldFont, color: rot });
  page.drawText('Zeitstempel: im Testmodus übersprungen', { x: 60, y: y - 18, size: 11, font, color: rot });
  return y - 44;
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

    // Always a fixed A4 portrait page, regardless of the preceding pages' own size/orientation —
    // an attached Beleg can end up A4 landscape (see belegAnhaengen.js), and the stamp page must
    // stay portrait rather than inherit that.
    const width = STAMP_WIDTH;
    const height = STAMP_HEIGHT;
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const boldFont = await doc.embedFont(StandardFonts.HelveticaBold);
    const maxWidth = width - PAGE_MARGIN;

    const stampPage = doc.addPage([width, height]);
    let y = height - 50;
    if (stampData.testmodus === true) y = zeichneTestmodusMarke(stampPage, boldFont, font, y);
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
      for (const line of wrapLine(boldFont, `Titel: ${einzeilig(stampData.titel)}`, 14, maxWidth)) {
        stampPage.drawText(line, { x: 60, y, size: 14, font: boldFont, color: rgb(0, 0, 0) });
        y -= 18;
      }
      y -= 12;
    }
    if (stampData.verwendungszweck) {
      for (const line of wrapLine(boldFont, `Verwendungszweck: ${einzeilig(stampData.verwendungszweck)}`, 14, maxWidth)) {
        stampPage.drawText(line, { x: 60, y, size: 14, font: boldFont, color: rgb(0, 0, 0) });
        y -= 18;
      }
      y -= 12;
    }
    // Kreditkarten-Teiljobs: macht auf dem Archivdokument sichtbar, ob ein Beleg vorliegt.
    if (stampData.kkHinweis) {
      for (const line of wrapLine(boldFont, stampData.kkHinweis, 12, maxWidth)) {
        stampPage.drawText(line, { x: 60, y, size: 12, font: boldFont, color: rgb(0, 0, 0) });
        y -= 16;
      }
      y -= 10;
    }
    // The payment data confirmed at Freigabe 2 (see freigabe2.js): the reimbursement account of a
    // Spesen position, or the QR-bill recipient of an invoice -- visible on the document itself and
    // not only in the n8n/Paperless API response.
    if (stampData.zahlungsdaten && (stampData.zahlungsdaten.iban || stampData.zahlungsdaten.kontoinhaber)) {
      stampPage.drawText('Zahlungsdaten', { x: 60, y, size: 11, font: boldFont, color: rgb(0, 0, 0) });
      y -= BLOCK_HEADING_GAP;
      const zahlungsdatenLines = [];
      if (stampData.zahlungsdaten.kontoinhaber) zahlungsdatenLines.push(`Kontoinhaber: ${stampData.zahlungsdaten.kontoinhaber}`);
      if (stampData.zahlungsdaten.empfaenger) zahlungsdatenLines.push(`Zahlungsempfänger: ${stampData.zahlungsdaten.empfaenger}`);
      if (stampData.zahlungsdaten.iban) zahlungsdatenLines.push(`IBAN: ${stampData.zahlungsdaten.iban}`);
      if (stampData.zahlungsdaten.referenz) zahlungsdatenLines.push(`Referenz: ${stampData.zahlungsdaten.referenz}`);
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
    const nachVerlauf = drawVerlauf(doc, font, stampData.verlauf, stampPage, y, width, height);
    drawKommentare(doc, font, boldFont, [{ kommentare: stampData.kommentare }], nachVerlauf, width, height);

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

    // Always a fixed A4 portrait page — see stampAndFinalize for why this no longer copies the
    // preceding pages' own size.
    const width = STAMP_WIDTH;
    const height = STAMP_HEIGHT;
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const boldFont = await doc.embedFont(StandardFonts.HelveticaBold);
    const maxWidth = width - PAGE_MARGIN;
    const TITLE_BOTTOM_MARGIN = 80; // room for up to ~2 wrapped title lines
    const FREIGABE_BLOCK_BOTTOM_MARGIN = 130; // heading(18) + up to 5 lines(14 each, with a Kommentar) = 88, plus headroom

    let stampPage = doc.addPage([width, height]);
    let y = height - 50;
    if (gruppenData.testmodus === true) y = zeichneTestmodusMarke(stampPage, boldFont, font, y);
    if (gruppenData.jobId != null) {
      stampPage.drawText(`Splitgruppe — Job-ID: ${gruppenData.jobId}`, { x: 60, y, size: 14, font: boldFont, color: rgb(0, 0, 0) });
      y -= 30;
    }

    for (const position of gruppenData.positionen) {
      if (y < TITLE_BOTTOM_MARGIN) {
        stampPage = doc.addPage([width, height]);
        y = height - 50;
      }
      const titelTeile = [`Konto: ${position.kontoNummer} — ${position.kontoBezeichnung}`, `Betrag: ${position.betrag}${position.typ === 'gutschrift' ? ' (Gutschrift)' : ''}`];
      if (position.position) titelTeile.push(`Position: ${position.position}`);
      for (const line of wrapLine(boldFont, titelTeile.join(' — '), 13, maxWidth)) {
        stampPage.drawText(line, { x: 60, y, size: 13, font: boldFont, color: rgb(0, 0, 0) });
        y -= 17;
      }
      y -= 10;
      if (position.kkHinweis) {
        for (const line of wrapLine(font, position.kkHinweis, 10, maxWidth)) {
          stampPage.drawText(line, { x: 60, y, size: 10, font, color: rgb(0, 0, 0) });
          y -= 14;
        }
        y -= 6;
      }
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
    const nachVerlauf = drawVerlauf(doc, font, gruppenData.verlauf, stampPage, y, width, height);
    // Je Teil ein Untertitel; Kommentare am Gesamtbeleg (Elternjob) zuerst.
    drawKommentare(doc, font, boldFont, [
      { untertitel: `Gesamtbeleg — Job-ID ${gruppenData.jobId}`, kommentare: gruppenData.kommentare },
      ...gruppenData.positionen.map((position, index) => ({
        untertitel: `Position ${index + 1}${position.position ? ` (${position.position})` : ''} — Konto ${position.kontoNummer} — Job-ID ${position.jobId}`,
        kommentare: position.kommentare,
      })),
    ], nachVerlauf, width, height);

    return Buffer.from(await doc.save());
  } catch {
    throw new Error('PDF konnte nicht gestempelt werden – Dokument ist ungültig oder enthält Zeichen, die nicht dargestellt werden können.');
  }
}
