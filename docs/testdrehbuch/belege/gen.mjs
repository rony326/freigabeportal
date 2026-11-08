// Erzeugt alle Testbelege für das Test-Runbook.
import pdflib from 'pdf-lib';
const { PDFDocument, StandardFonts, rgb, degrees } = pdflib;
import * as mupdf from 'mupdf';
import QRCode from 'qrcode';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

const OUT = new URL('./out/', import.meta.url).pathname;
const dir = (d) => { const p = join(OUT, d); mkdirSync(p, { recursive: true }); return p; };
const D_R = dir('1_Rechnungen'), D_K = dir('2_Kreditkarte'), D_S = dir('3_Spesen'), D_X = dir('4_Sonderfaelle');
const mm = (v) => v * 72 / 25.4;

// ---------- IBAN mit gültiger Prüfziffer
function mod97(s) { let r = 0; for (const ch of s) r = (r * 10 + Number(ch)) % 97; return r; }
function ibanCH(bban) {
  const num = (bban + 'CH00').replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  const check = String(98 - mod97(num)).padStart(2, '0');
  return `CH${check}${bban}`;
}
const gruppe = (iban) => iban.replace(/(.{4})/g, '$1 ').trim();
const IBAN_TEST = ibanCH('00700110000123456');   // Testlieferant AG (hinterlegen)
const IBAN_FREMD = ibanCH('08390033445566778');  // gefälscht, R3
const IBAN_ZWEI = ibanCH('00235123456789012');   // Zweiter Lieferant GmbH (nicht hinterlegt)

const SCHULDNER = { name: 'Testgemeinde Freigabeportal', str: 'Musterweg', nr: '1', plz: '3000', ort: 'Bern' };
const TEST = { name: 'Testlieferant AG', str: 'Probegasse', nr: '12', plz: '8000', ort: 'Zürich', mail: 'rechnung@testlieferant.invalid', mwst: 'CHE-000.000.001 MWST' };
const ZWEI = { name: 'Zweiter Lieferant GmbH', str: 'Beispielstrasse', nr: '7', plz: '4000', ort: 'Basel', mail: 'buchhaltung@zweiter-lieferant.invalid', mwst: 'CHE-000.000.002 MWST' };

const chf = (n) => n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, "'");
const datum = (iso) => { const [y, m, d] = iso.split('-'); return `${d}.${m}.${y}`; };
const plusTage = (iso, t) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + t); return d.toISOString().slice(0, 10); };

// ---------- QR-Payload (SPC 0200, strukturierte Adressen, Referenz NON)
function qrPayload({ iban, kred, betrag, mitteilung }) {
  const adr = (a) => ['S', a.name, a.str, a.nr, a.plz, a.ort, 'CH'];
  return ['SPC', '0200', '1', iban, ...adr(kred), '', '', '', '', '', '', '', betrag.toFixed(2), 'CHF',
    ...adr(SCHULDNER), 'NON', '', mitteilung, 'EPD'].join('\n');
}

async function qrPng(text) {
  return QRCode.toBuffer(text, { errorCorrectionLevel: 'M', margin: 0, scale: 8, type: 'png' });
}

// ---------- Rechnung
async function rechnung(o) {
  const doc = await PDFDocument.create();
  doc.setTitle(`${o.titel || 'Rechnung'} ${o.nr}`); doc.setAuthor(o.kred.name); doc.setCreator('Testbeleg-Generator');
  const page = doc.addPage([mm(210), mm(297)]);
  const f = await doc.embedFont(StandardFonts.Helvetica), fb = await doc.embedFont(StandardFonts.HelveticaBold);
  const t = (s, x, y, size = 10, font = f, color = rgb(0.1, 0.1, 0.1)) => page.drawText(s, { x: mm(x), y: mm(297 - y), size, font, color });
  const tr = (s, xr, y, size = 10, font = f) => t(s, xr - font.widthOfTextAtSize(s, size) / mm(1), y, size, font);

  // Wasserzeichen
  page.drawText('TESTBELEG', { x: mm(40), y: mm(110), size: 90, font: fb, color: rgb(0.93, 0.93, 0.93), rotate: degrees(35) });

  t(o.kred.name, 20, 22, 16, fb);
  t(`${o.kred.str} ${o.kred.nr} · ${o.kred.plz} ${o.kred.ort} · ${o.kred.mail}`, 20, 28, 8.5);
  t(o.kred.mwst, 20, 32, 8.5);
  [SCHULDNER.name, 'Buchhaltung', `${SCHULDNER.str} ${SCHULDNER.nr}`, `${SCHULDNER.plz} ${SCHULDNER.ort}`].forEach((l, i) => t(l, 120, 50 + i * 5));

  const titel = o.titel || 'Rechnung';
  t(`${titel} Nr. ${o.nr}`, 20, 82, 15, fb);
  t(`${o.gutschrift ? 'Datum' : 'Rechnungsdatum'}: ${datum(o.datum)}`, 20, 90);
  if (o.ziel) t(`Zahlbar bis: ${datum(o.ziel)}`, 20, 95);
  if (o.vermerk) { t(o.vermerk, 120, 82, 15, fb, rgb(0.75, 0.1, 0.1)); }

  let y = 108;
  t('Pos.', 20, y, 9, fb); t('Beschreibung', 32, y, 9, fb); tr('Betrag CHF', 190, y, 9, fb);
  page.drawLine({ start: { x: mm(20), y: mm(297 - y - 2) }, end: { x: mm(190), y: mm(297 - y - 2) }, thickness: 0.6 });
  y += 8;
  o.pos.forEach(([text, betrag], i) => { t(String(i + 1), 20, y, 9.5); t(text, 32, y, 9.5); tr(chf(betrag), 190, y, 9.5); y += 6; });
  const total = o.pos.reduce((s, p) => s + p[1], 0);
  page.drawLine({ start: { x: mm(120), y: mm(297 - y + 2) }, end: { x: mm(190), y: mm(297 - y + 2) }, thickness: 0.6 });
  y += 4;
  t(o.gutschrift ? 'Gutschrift total CHF' : 'Total CHF', 120, y, 11, fb); tr(chf(total), 190, y, 11, fb);
  t('inkl. 8.1 % MWST', 120, y + 5, 8);
  y += 18;
  (o.hinweis || []).forEach((l) => { t(l, 20, y, 9); y += 5; });

  if (o.iban) {
    // Zahlteil (vereinfacht nach Style Guide): Empfangsschein 62 mm + Zahlteil, unten 105 mm
    const top = 297 - 105;
    page.drawLine({ start: { x: 0, y: mm(105) }, end: { x: mm(210), y: mm(105) }, thickness: 0.5, dashArray: [3, 3] });
    page.drawLine({ start: { x: mm(62), y: 0 }, end: { x: mm(62), y: mm(105) }, thickness: 0.5, dashArray: [3, 3] });
    const kadr = [gruppe(o.iban), o.kred.name, `${o.kred.str} ${o.kred.nr}`, `${o.kred.plz} ${o.kred.ort}`];
    const sadr = [SCHULDNER.name, `${SCHULDNER.str} ${SCHULDNER.nr}`, `${SCHULDNER.plz} ${SCHULDNER.ort}`];
    t('Empfangsschein', 5, top + 10, 11, fb);
    t('Konto / Zahlbar an', 5, top + 17, 6, fb); kadr.forEach((l, i) => t(l, 5, top + 21 + i * 3.5, 8));
    t('Zahlbar durch', 5, top + 40, 6, fb); sadr.forEach((l, i) => t(l, 5, top + 44 + i * 3.5, 8));
    t('Währung', 5, top + 70, 6, fb); t('CHF', 5, top + 74, 8);
    t('Betrag', 22, top + 70, 6, fb); t(chf(total), 22, top + 74, 8);
    t('Annahmestelle', 38, top + 90, 6, fb);

    t('Zahlteil', 67, top + 10, 11, fb);
    const png = await doc.embedPng(await qrPng(qrPayload({ iban: o.iban, kred: o.kred, betrag: total, mitteilung: `Rechnung ${o.nr}` })));
    page.drawImage(png, { x: mm(67), y: mm(105 - 17 - 46), width: mm(46), height: mm(46) });
    // Schweizerkreuz in der Mitte
    const cx = mm(67 + 23), cy = mm(105 - 17 - 23), s = mm(7);
    page.drawRectangle({ x: cx - s / 2, y: cy - s / 2, width: s, height: s, color: rgb(1, 1, 1) });
    page.drawRectangle({ x: cx - s * 0.43, y: cy - s * 0.43, width: s * 0.86, height: s * 0.86, color: rgb(0, 0, 0) });
    page.drawRectangle({ x: cx - s * 0.1, y: cy - s * 0.3, width: s * 0.2, height: s * 0.6, color: rgb(1, 1, 1) });
    page.drawRectangle({ x: cx - s * 0.3, y: cy - s * 0.1, width: s * 0.6, height: s * 0.2, color: rgb(1, 1, 1) });
    t('Währung', 67, top + 72, 8, fb); t('CHF', 67, top + 76, 10);
    t('Betrag', 85, top + 72, 8, fb); t(chf(total), 85, top + 76, 10);
    t('Konto / Zahlbar an', 118, top + 10, 8, fb); kadr.forEach((l, i) => t(l, 118, top + 14 + i * 4, 10));
    t('Zusätzliche Informationen', 118, top + 34, 8, fb); t(`Rechnung ${o.nr}`, 118, top + 38, 10);
    t('Zahlbar durch', 118, top + 46, 8, fb); sadr.forEach((l, i) => t(l, 118, top + 50 + i * 4, 10));
  } else if (!o.gutschrift) {
    t('Bitte überweisen Sie den Betrag innert 30 Tagen auf folgendes Konto:', 20, y + 4, 9);
    t(`${o.kred.name}, IBAN ${gruppe(IBAN_TEST)}, Vermerk: Rechnung ${o.nr}`, 20, y + 9, 9);
  }
  return Buffer.from(await doc.save());
}

const R = [];
const save = (d, name, buf) => { const p = join(d, name); writeFileSync(p, buf); R.push(p); return p; };

const BASIS = '2026-10-20';
// R1 / R2 / R2b: gleicher Betrag und gleiches Zahlungsziel
const r1 = { kred: TEST, nr: '1001', datum: BASIS, ziel: plusTage(BASIS, 30), iban: IBAN_TEST,
  pos: [['Beamer-Lampe Ersatz', 289.0], ['Lautsprecherkabel 10 m (3 Stk.)', 118.5], ['Versand und Verpackung', 79.85]] };
save(D_R, 'R1_Testlieferant_Rechnung-1001_QR.pdf', await rechnung(r1));
save(D_R, 'R2_Testlieferant_Rechnung-1001_KOPIE.pdf', await rechnung({ ...r1, vermerk: 'KOPIE', hinweis: ['Kopie der Rechnung vom 20.10.2026 — bitte nicht doppelt bezahlen.'] }));
save(D_R, 'R2b_Testlieferant_Rechnung-1002_gleicher-Betrag.pdf', await rechnung({ ...r1, nr: '1002', datum: '2026-10-21' }));
save(D_R, 'R3_Testlieferant_Rechnung-1003_FALSCHE-IBAN.pdf', await rechnung({ kred: TEST, nr: '1003', datum: '2026-10-22', ziel: '2026-11-21', iban: IBAN_FREMD,
  pos: [['Mikrofon-Funkstrecke', 312.4]], hinweis: ['Achtung Test: Diese QR-Rechnung trägt eine andere IBAN als beim Lieferanten hinterlegt.'] }));

const ohneQr = [
  ['R4', '2001', [['Druck Gemeindebrief (500 Ex.)', 156.8]], '2026-10-23', 25],
  ['R4b', '2002', [['Kaffeebohnen 5 kg', 89.9]], '2026-10-23', 32],
  ['R4c', '2003', [['Reparatur Orgelpedal', 233.15]], '2026-10-24', 34],
  ['R4d', '2004', [['Wartung Heizung', 412.0]], '2026-10-24', 36],
  ['R4e', '2005', [['Reinigungsmittel', 75.25]], '2026-10-25', 38],
  ['R4f', '2006', [['Büromaterial', 198.7]], '2026-10-25', 40],
  ['R8', '6001', [['Glühbirnen und Sicherungen', 127.6]], '2026-10-26', 42],
];
for (const [id, nr, pos, d, z] of ohneQr) {
  save(D_R, `${id}_Testlieferant_Rechnung-${nr}_ohne-QR.pdf`, await rechnung({ kred: TEST, nr, datum: d, ziel: plusTage(d, z), pos }));
}
save(D_R, 'R5_Testlieferant_Sammelrechnung-3001_600CHF.pdf', await rechnung({ kred: TEST, nr: '3001', datum: '2026-10-22', ziel: '2026-11-30', iban: IBAN_TEST,
  pos: [['Pos. 1 Lager-Zelte Miete (Jugend)', 250.0], ['Pos. 2 Notenständer 4 Stk. (Musik)', 200.0], ['Pos. 3 Aktenschrank (Verwaltung)', 150.0]],
  hinweis: ['Sammelrechnung: drei Bereiche, bitte aufsplitten.'] }));
save(D_R, 'R6_Testlieferant_Gutschrift-G4001.pdf', await rechnung({ kred: TEST, nr: 'G-4001', titel: 'Gutschrift', gutschrift: true, datum: '2026-10-24',
  pos: [['Rücknahme Lautsprecherkabel (2 Stk.)', 80.0]], hinweis: ['Der Betrag wird mit der nächsten Rechnung verrechnet.'] }));
save(D_R, 'R7a_ZweiterLieferant_Rechnung-5001_QR.pdf', await rechnung({ kred: ZWEI, nr: '5001', datum: '2026-10-21', ziel: '2026-11-20', iban: IBAN_ZWEI, pos: [['Stuhlhussen Reinigung', 264.5]] }));
save(D_R, 'R7b_ZweiterLieferant_Rechnung-5002_QR.pdf', await rechnung({ kred: ZWEI, nr: '5002', datum: '2026-10-25', ziel: '2026-11-24', iban: IBAN_ZWEI, pos: [['Tischtücher Reinigung', 341.75]] }));

// ---------- Kreditkarte
async function kkAbrechnung() {
  const doc = await PDFDocument.create(); doc.setTitle('Monatsabrechnung Test-Visa Oktober 2026');
  const page = doc.addPage([mm(210), mm(297)]);
  const f = await doc.embedFont(StandardFonts.Helvetica), fb = await doc.embedFont(StandardFonts.HelveticaBold);
  const t = (s, x, y, size = 10, font = f) => page.drawText(s, { x: mm(x), y: mm(297 - y), size, font, color: rgb(0.1, 0.1, 0.1) });
  page.drawText('TESTBELEG', { x: mm(40), y: mm(110), size: 90, font: fb, color: rgb(0.93, 0.93, 0.93), rotate: degrees(35) });
  t('Testbank Kartenservice', 20, 22, 16, fb);
  t('Monatsabrechnung Oktober 2026', 20, 40, 14, fb);
  t('Test-Visa · Karte **** **** **** 4242 · Karteninhaber: Testgemeinde Freigabeportal', 20, 47, 9.5);
  t('Abrechnungsperiode 01.10.2026 bis 31.10.2026', 20, 52, 9.5);
  let y = 66;
  t('Datum', 20, y, 9, fb); t('Beschreibung', 42, y, 9, fb); t('Betrag CHF', 146, y, 9, fb);
  y += 8;
  const zeilen = [
    ['08.10.2026', 'Bastelshop Muster, Bern', '45.20'],
    ['12.10.2026', 'Musikhaus Test, Zuerich', '120.00'],
    ['15.10.2026', 'Papeterie Konstanz (EUR 31.95)', '30.10'],
    ['18.10.2026', 'Elektro Test, Gutschrift Rueckgabe', '-15.00'],
    ['21.10.2026', 'Online-Shop Test', '18.90'],
    ['25.10.2026', 'Jahresgebuehr Karte', '5.00'],
  ];
  const fm = await doc.embedFont(StandardFonts.Courier);
  for (const [d, b, a] of zeilen) { page.drawText(`${d}  ${b.padEnd(40)}${a.padStart(10)}`, { x: mm(20), y: mm(297 - y), size: 9.5, font: fm }); y += 6; }
  y += 4;
  t('Total zu bezahlen CHF 204.20', 20, y, 11, fb);
  t('Belastung per Lastschrift am 10.11.2026', 20, y + 7, 9);
  return Buffer.from(await doc.save());
}
save(D_K, 'KK1_Monatsabrechnung_Test-Visa_Oktober-2026.pdf', await kkAbrechnung());
save(D_K, 'KK2_Testlieferant_Rechnung-7001_keine-Kartenabrechnung.pdf', await rechnung({ kred: TEST, nr: '7001', datum: '2026-10-26', ziel: '2026-11-25', pos: [['Batterien AA (40 Stk.)', 58.4]] }));

// ---------- Quittungen als Bild (über mupdf gerendert)
async function quittungPdf(o) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([mm(80), mm(o.h || 120)]);
  const f = await doc.embedFont(StandardFonts.Courier), fb = await doc.embedFont(StandardFonts.CourierBold);
  let y = 10; const H = o.h || 120;
  const t = (s, size = 8.5, font = f) => { page.drawText(s, { x: mm(6), y: mm(H - y), size, font }); y += size * 0.55; };
  t(o.laden, 10, fb); o.adr.forEach((l) => t(l)); y += 2; t(`Datum: ${o.datum}`); t(`Beleg-Nr. ${o.nr}`); y += 2;
  t('-'.repeat(32));
  o.pos.forEach(([a, b]) => t(`${a.padEnd(22)}${b.padStart(10)}`));
  t('-'.repeat(32));
  t(`${'TOTAL ' + (o.waehrung || 'CHF')}`.padEnd(22) + o.total.padStart(10), 9.5, fb);
  y += 2; (o.fuss || ['Zahlung: Visa **** 4242', 'Vielen Dank!']).forEach((l) => t(l, 8));
  t('*** TESTBELEG ***', 8, fb);
  return Buffer.from(await doc.save());
}
function alsBild(pdfBuf, format, scale = 3, grau = false) {
  const d = mupdf.Document.openDocument(pdfBuf, 'application/pdf');
  const pix = d.loadPage(0).toPixmap(mupdf.Matrix.scale(scale, scale), grau ? mupdf.ColorSpace.DeviceGray : mupdf.ColorSpace.DeviceRGB, false, true);
  return Buffer.from(format === 'jpg' ? pix.asJPEG(80) : pix.asPNG());
}
const kb1 = await quittungPdf({ laden: 'BASTELSHOP MUSTER', adr: ['Bastelweg 3', '3000 Bern'], datum: '08.10.2026', nr: '58812',
  pos: [['Moosgummi Set', '18.90'], ['Leim 6 Stk.', '14.40'], ['Scheren 4 Stk.', '11.90']], total: '45.20' });
save(D_K, 'KB1_Quittung_Bastelshop_45.20_08.10.2026.jpg', alsBild(kb1, 'jpg'));
const kb2 = await quittungPdf({ laden: 'MUSIKHAUS TEST', adr: ['Tonleiter 8', '8000 Zuerich'], datum: '12.10.2026', nr: 'M-2210',
  pos: [['Chornoten Advent', '96.00'], ['Kopierlizenz', '24.00']], total: '120.00' });
save(D_K, 'KB2_Quittung_Musikhaus-Noten_120.00_12.10.2026.pdf', kb2);
const kb3 = await quittungPdf({ laden: 'PAPETERIE KONSTANZ', adr: ['Marktstaette 1', 'D-78462 Konstanz'], datum: '15.10.2026', nr: '0099', waehrung: 'EUR',
  pos: [['Flipchart-Papier', '22.95'], ['Marker 12 Stk.', '9.00']], total: '31.95', fuss: ['Zahlung: Visa **** 4242', 'Belastet: CHF 30.10']});
save(D_K, 'KB3_Quittung_Papeterie-EUR-31.95_CHF-30.10_15.10.2026.png', alsBild(kb3, 'png', 2.5));
const kb4 = await quittungPdf({ laden: 'ELEKTRO TEST', adr: ['Stromgasse 5', '3000 Bern'], datum: '18.10.2026', nr: 'R-311',
  pos: [['RUECKGABE Kabel HDMI', '-15.00']], total: '-15.00', fuss: ['Gutschrift auf Visa **** 4242', 'Danke fuer Ihren Einkauf']});
save(D_K, 'KB4_Quittung_Rueckerstattung_-15.00_18.10.2026.jpg', alsBild(kb4, 'jpg'));

// ---------- Spesen-Quittungen
const sq = [
  ['SQ1_Spesen_Baeckerei-Apero_38.60.jpg', 'jpg', { laden: 'BAECKEREI TEST', adr: ['Brotgasse 2', '3000 Bern'], datum: '17.10.2026', nr: '4471', pos: [['Zopf 2 Stk.', '16.80'], ['Gipfeli 12 Stk.', '21.80']], total: '38.60', fuss: ['Bar bezahlt', 'Vielen Dank!'] }],
  ['SQ2_Spesen_Bahnbillett_24.80.pdf', 'pdf', { laden: 'BAHN TEST', adr: ['Billett Bern - Thun retour', '2. Klasse, Halbtax'], datum: '19.10.2026', nr: 'BT-778201', pos: [['Bern - Thun retour', '24.80']], total: '24.80', fuss: ['Bezahlt mit TWINT'] }],
  ['SQ3_Spesen_Parkticket_12.00.png', 'png', { laden: 'PARKHAUS TEST', adr: ['Parkstrasse 10', '3600 Thun'], datum: '19.10.2026', nr: 'P-5531', pos: [['Parkdauer 4h', '12.00']], total: '12.00', fuss: ['Bezahlt mit Karte'], h: 90 }],
  ['SQ4_Spesen_Blumen-Dank_45.00.jpg', 'jpg', { laden: 'BLUMEN TEST', adr: ['Rosenweg 4', '3000 Bern'], datum: '22.10.2026', nr: '1209', pos: [['Blumenstrauss', '45.00']], total: '45.00', fuss: ['Bar bezahlt'] }],
];
for (const [name, fmt, o] of sq) {
  const pdf = await quittungPdf(o);
  save(D_S, name, fmt === 'pdf' ? pdf : alsBild(pdf, fmt, fmt === 'png' ? 2.5 : 3));
}
// Belege mit ungültigem Datum / zu gross
save(D_S, 'SQ5_Spesen_Datum-in-der-Zukunft_31.12.2026.jpg', alsBild(await quittungPdf({ laden: 'KIOSK TEST', adr: ['Bahnhof', '3000 Bern'], datum: '31.12.2026', nr: '1', pos: [['Getraenke', '9.50']], total: '9.50', fuss: ['Bar bezahlt'] }), 'jpg'));

async function mitBallast(basisPdf, mb, name) {
  const doc = await PDFDocument.load(basisPdf);
  await doc.attach(randomBytes(mb * 1024 * 1024), 'ballast.bin', { mimeType: 'application/octet-stream', description: 'Füllmaterial für Grössentest' });
  return Buffer.from(await doc.save());
}
save(D_S, 'SQ6_Spesen_ZU-GROSS_ueber-20MB.pdf', await mitBallast(await quittungPdf({ laden: 'GROSSER BELEG', adr: ['Testdatei > 20 MB'], datum: '20.10.2026', nr: '9', pos: [['Grössentest', '10.00']], total: '10.00' }), 21));

// ---------- Sonderfälle
const x1Basis = await rechnung({ kred: TEST, nr: '8001', datum: '2026-10-24', ziel: '2026-11-23', pos: [['Passwortgeschützte Testrechnung', 99.0]] });
{
  const d = mupdf.Document.openDocument(x1Basis, 'application/pdf');
  const buf = d.asPDF().saveToBuffer('encrypt=aes-256,user-password=test,owner-password=test-owner');
  save(D_X, 'X1_passwortgeschuetzt_Passwort-test.pdf', Buffer.from(buf.asUint8Array()));
}
{
  const b = await rechnung({ kred: TEST, nr: '8002', datum: '2026-10-24', ziel: '2026-11-23', pos: [['Kaputte Testrechnung', 50.0]] });
  save(D_X, 'X2_beschaedigt.pdf', b.subarray(0, Math.floor(b.length * 0.45)));
}
save(D_X, 'X3_gross_ca-15MB.pdf', await mitBallast(await rechnung({ kred: TEST, nr: '8003', datum: '2026-10-24', ziel: '2026-11-23', pos: [['Grosse Testrechnung (Anhang ~15 MB)', 66.6]] }), 15));
save(D_X, 'X4_Rechnung_als_Foto.jpg', alsBild(await rechnung({ kred: TEST, nr: '8004', datum: '2026-10-24', ziel: '2026-11-23', pos: [['Rechnung als Foto', 44.4]] }), 'jpg', 1.6, true));


// ---------- Neu seit Stand 2026-11-07: Rapport, Sonderzeichen im Dateinamen, Budget-Import
async function rapportPdf(titel = 'Rapport Hauswartung Oktober 2026', zeilen = null) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([mm(210), mm(297)]);
  const f = await doc.embedFont(StandardFonts.Helvetica), fb = await doc.embedFont(StandardFonts.HelveticaBold);
  let y = 30;
  const t = (s, size = 11, font = f) => { page.drawText(s, { x: mm(25), y: mm(297 - y), size, font }); y += size * 0.6; };
  t('Hauswartung Testgemeinde', 10, fb); t('Musterweg 1, 3000 Bern', 10); y += 12;
  t(titel, 16, fb); y += 6;
  (zeilen || ['Heizung: Jahreskontrolle durchgeführt, keine Mängel.', 'Beleuchtung Saal: zwei Leuchtmittel ersetzt.',
   'Dachrinne Nordseite: Laub entfernt.', 'Nächste Kontrolle: Januar 2027.', '',
   'Dieses Dokument ist keine Rechnung und muss nicht bezahlt werden.', 'Bitte nur zur Kenntnis nehmen.']).forEach((l) => t(l));
  page.drawText('TESTBELEG', { x: mm(40), y: mm(110), size: 80, font: fb, color: rgb(0.85, 0.85, 0.85), rotate: degrees(35), opacity: 0.5 });
  return Buffer.from(await doc.save());
}
save(D_R, 'RP1_Rapport_Hauswartung_Oktober-2026.pdf', await rapportPdf());
save(D_R, 'RP2_Rapport_Reinigung_Oktober-2026.pdf', await rapportPdf('Rapport Reinigung Oktober 2026', ['Grundreinigung Saal und Küche erledigt.', 'Fenster Westseite: Reinigung im November.', '', 'Dieses Dokument ist keine Rechnung.', 'Bitte nur zur Kenntnis nehmen.']));
save(D_X, 'X5_Rechnung 9001 – Kaffee 50 €.pdf', await rechnung({ kred: TEST, nr: '9001', datum: '2026-10-28', ziel: '2026-11-27', pos: [['Kaffee für Gemeindeanlass', 50.0]] }));

const D_B = dir('5_Budgets');
const budgetZeilen = [['Kontonummer', 'Budget 2026'], ['T1', "1'500.–"], ['T2', '2000'], ['T3', '800.00'], ['T4', '1 200,50'], ['T9', '300'], ['T2', 'viel']];
save(D_B, 'BU1_Budgets_2026.csv', Buffer.from('﻿' + budgetZeilen.map((z) => z.join(';')).join('\r\n') + '\r\n', 'utf8'));
{
  const AdmZip = (await import('adm-zip')).default;
  const zelle = (w, ref) => (typeof w === 'number' ? `<c r="${ref}"><v>${w}</v></c>` : `<c r="${ref}" t="inlineStr"><is><t>${String(w).replaceAll('&', '&amp;').replaceAll('<', '&lt;')}</t></is></c>`);
  const xz = [['Konto', 'Bezeichnung', 'Betrag'], ['T1', 'Test Jugend', 1600], ['T2', 'Test Musik', 2100], ['T3', 'Test Buchhaltung', 900], ['T4', 'Test Verwaltung', 1300]];
  const daten = xz.map((z, r) => `<row r="${r + 1}">${z.map((w, c) => zelle(w, `${String.fromCharCode(65 + c)}${r + 1}`)).join('')}</row>`).join('');
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'));
  zip.addFile('_rels/.rels', Buffer.from('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'));
  zip.addFile('xl/workbook.xml', Buffer.from('<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Budget 2027" sheetId="1" r:id="rId1"/></sheets></workbook>'));
  zip.addFile('xl/_rels/workbook.xml.rels', Buffer.from('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'));
  zip.addFile('xl/worksheets/sheet1.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${daten}</sheetData></worksheet>`));
  save(D_B, 'BU2_Budgets_2027.xlsx', zip.toBuffer());
}

writeFileSync(join(OUT, 'ibans.json'), JSON.stringify({ IBAN_TEST, IBAN_FREMD, IBAN_ZWEI }, null, 2));
console.log(R.length, 'Dateien'); console.log({ IBAN_TEST: gruppe(IBAN_TEST), IBAN_FREMD: gruppe(IBAN_FREMD), IBAN_ZWEI: gruppe(IBAN_ZWEI) });
