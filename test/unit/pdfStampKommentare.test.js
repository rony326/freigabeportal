import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import * as mupdf from 'mupdf';
import { stampAndFinalize, stampGruppenDokument, winAnsiSicher } from '../../src/services/pdfStamp.js';
import { extrahierePdfText } from '../../src/services/pdfText.js';
import { buildPdfFixture } from '../helpers/pdfFixture.js';

function freigeber(name, kommentar = null) {
  return { name, identitaet: 'ct-1', zeitpunkt: '2026-10-20T08:30:00.000Z', ip: '1.2.3.4', interessenskonflikt: false, kommentar };
}

function stampData(extra = {}) {
  return {
    jobId: 42,
    konto: { nummer: '3000', bezeichnung: 'Unterhalt' },
    freigeber1: freigeber('Max Muster'),
    freigeber2: freigeber('Erika Beispiel'),
    verlauf: [{ rolleLabel: 'Freigabe 1', ...freigeber('Max Muster') }],
    ...extra,
  };
}

const kommentar = (text, extra = {}) => ({ zeitpunkt: '2026-10-21T12:05:00.000Z', verfasser: 'Anna Beispiel', text, ...extra });
const seiten = async (bytes) => (await PDFDocument.load(bytes)).getPageCount();
// mupdf trennt Wörter, die über eine Zeile hinausgehen, nicht -- für Vergleiche Zeilenumbrüche entfernen.
const ohneUmbrueche = (text) => text.replace(/\s+/g, '');

function seitenTexte(bytes) {
  const doc = mupdf.Document.openDocument(bytes, 'application/pdf');
  try {
    return Array.from({ length: doc.countPages() }, (_, i) => {
      const page = doc.loadPage(i);
      try { return page.toStructuredText().asText(); } finally { page.destroy(); }
    });
  } finally {
    doc.destroy();
  }
}

const letzteZeile = (seitenText) => seitenText.split('\n').map((z) => z.trim()).filter(Boolean).at(-1);
const KOPFZEILE = /^\d\d\.\d\d\.\d{4} \d\d:\d\d — .*:$/;

test('winAnsiSicher erhält Umlaute, ß, € und typografische Zeichen, ersetzt den Rest durch ?', () => {
  assert.equal(winAnsiSicher('Grüße äöü ÄÖÜ ß 12 € – „gut“ …'), 'Grüße äöü ÄÖÜ ß 12 € – „gut“ …');
  assert.equal(winAnsiSicher('ok 😀 Привет'), 'ok ? ??????');
  assert.equal(winAnsiSicher('a\tb\u0007c'), 'a b?c');
  assert.equal(winAnsiSicher('Zeile 1\r\nZeile 2\rZeile 3\nZeile 4'), 'Zeile 1\nZeile 2\nZeile 3\nZeile 4');
  assert.equal(winAnsiSicher('Müller'), 'Müller', 'zerlegte Umlaute werden per NFC zusammengesetzt');
  assert.equal(winAnsiSicher(null), '');
});

test('winAnsiSicher ersetzt ein sichtbares Emoji (ZWJ-Folge, Flagge, Variantenselektor) durch genau ein ?', () => {
  assert.equal(winAnsiSicher('a 👨‍👩‍👧 b'), 'a ? b');
  assert.equal(winAnsiSicher('❤️'), '?');
  assert.equal(winAnsiSicher('🇨🇭!'), '?!');
  assert.equal(winAnsiSicher('👍🏽 ok'), '? ok', 'Hautton-Modifikator gehört zum Emoji');
  assert.equal(winAnsiSicher('Zeile\r\nZwei'), 'Zeile\nZwei', 'CRLF bleibt ein Zeilenumbruch');
});

test('stampAndFinalize druckt den Abschnitt "Rückfragen und Kommentare" mit Zeitpunkt, Verfasser und Text', async () => {
  const pdf = await buildPdfFixture(['Rechnung Seite 1']);
  const stamped = await stampAndFinalize(pdf, stampData({
    kommentare: [kommentar('Bitte Lieferschein beilegen.'), kommentar('Liegt bei, danke.', { verfasser: 'Max Muster', zeitpunkt: '2026-10-21T22:30:00.000Z' })],
  }));
  const text = extrahierePdfText(stamped);
  assert.match(text, /Rückfragen und Kommentare/);
  // 12:05 UTC = 14:05 Sommerzeit Zürich; 22:30 UTC = 00:30 am Folgetag
  assert.match(text, /21\.10\.2026 14:05 — Anna Beispiel:/);
  assert.match(text, /Bitte Lieferschein beilegen\./);
  assert.match(text, /22\.10\.2026 00:30 — Max Muster:/);
  assert.match(text, /Liegt bei, danke\./);
  assert.ok(text.indexOf('Verlauf') < text.indexOf('Rückfragen und Kommentare'), 'Abschnitt folgt nach dem Verlauf');
  assert.ok(text.indexOf('Bitte Lieferschein') < text.indexOf('Liegt bei'), 'chronologisch in der übergebenen Reihenfolge');
});

test('Zeilenumbrüche im Kommentar werden zu eigenen Zeilen', async () => {
  const pdf = await buildPdfFixture(['Rechnung Seite 1']);
  const stamped = await stampAndFinalize(pdf, stampData({ kommentare: [kommentar('Erste Zeile\r\nZweite Zeile\n\nDritte Zeile')] }));
  const zeilen = extrahierePdfText(stamped).split('\n').map((z) => z.trim());
  for (const z of ['Erste Zeile', 'Zweite Zeile', 'Dritte Zeile']) assert.ok(zeilen.includes(z), `${z} als eigene Zeile`);
});

test('Emoji/Kyrillisch in Kommentar und Verfasser werden zu ?, Stempeln wirft nicht', async () => {
  const pdf = await buildPdfFixture(['Rechnung Seite 1']);
  const stamped = await stampAndFinalize(pdf, stampData({
    kommentare: [kommentar('Danke 😀 Привет, Grüße', { verfasser: 'Иван Müller' })],
  }));
  const text = extrahierePdfText(stamped);
  assert.match(text, /Danke \? \?\?\?\?\?\?, Grüße/);
  assert.match(text, /\?\?\?\? Müller:/);
});

test('bisher werfende Eingaben (Emoji in Freigabe-/Verlauf-Kommentar, Titel, Verwendungszweck, Namen) werden jetzt gestempelt', async () => {
  const pdf = await buildPdfFixture(['Rechnung Seite 1']);
  const data = stampData({ titel: 'Ausflug 🚌', verwendungszweck: 'Znüni ☕ für Team' });
  data.freigeber1 = freigeber('Ольга Muster', 'ok 👍');
  data.freigeber2 = freigeber('Erika Beispiel', 'Zeile\nmit Umbruch\tund Tab');
  data.verlauf = [{ rolleLabel: 'Freigabe 1', ...freigeber('Ольга Muster', '😀 nicht darstellbar') }];
  const stamped = await stampAndFinalize(pdf, data);
  const text = extrahierePdfText(stamped);
  assert.match(text, /Titel: Ausflug \?/);
  assert.match(text, /Verwendungszweck: Znüni \? für Team/);
  assert.match(text, /\?\?\?\?\? Muster/);
  assert.match(text, /Kommentar: ok \?/);
  assert.match(text, /Kommentar: \? nicht darstellbar/);
  assert.match(text, /Kommentar: Zeile mit Umbruch und Tab/);
});

test('ein Wort mit 2000 Zeichen wird hart umbrochen und vollständig gedruckt', async () => {
  const pdf = await buildPdfFixture(['Rechnung Seite 1']);
  const wort = Array.from({ length: 2000 }, (_, i) => String.fromCharCode(65 + (i % 26))).join('');
  const stamped = await stampAndFinalize(pdf, stampData({ kommentare: [kommentar(wort)] }));
  const text = extrahierePdfText(stamped);
  assert.ok(ohneUmbrueche(text).includes(wort), 'kein Zeichen des langen Worts fehlt');
  const wortZeilen = text.split('\n').map((z) => z.trim()).filter((z) => /^[A-Z]{20,}$/.test(z));
  assert.ok(wortZeilen.length > 10, `hart in viele Zeilen umbrochen (${wortZeilen.length})`);
  // Helvetica 9pt, ~483pt Zeilenbreite: breite Grossbuchstaben passen höchstens ~80 pro Zeile.
  for (const z of wortZeilen) assert.ok(z.length <= 90, `keine Zeile breiter als die Seite (${z.length} Zeichen)`);
});

test('30 lange Kommentare laufen auf Folgeseiten weiter, kein Text fehlt', async () => {
  const pdf = await buildPdfFixture(['Rechnung Seite 1']);
  const kommentare = Array.from({ length: 30 }, (_, i) => kommentar(`Kommentar Nummer ${i + 1} Ende. ${'Fülltext mit Wörtern '.repeat(40)}Schluss${i + 1}.`));
  const ohne = await stampAndFinalize(pdf, stampData());
  const mit = await stampAndFinalize(pdf, stampData({ kommentare }));
  assert.ok(await seiten(mit) > await seiten(ohne) + 1, 'mehrere Folgeseiten');
  const text = extrahierePdfText(mit);
  assert.match(text, /Rückfragen und Kommentare \(Fortsetzung\)/);
  for (let i = 1; i <= 30; i++) {
    assert.match(text, new RegExp(`Kommentar Nummer ${i} Ende\\.`));
    assert.match(text, new RegExp(`Schluss${i}\\.`));
  }
});

test('ohne Kommentare kein Abschnitt und gleiche Seitenzahl wie vorher', async () => {
  const pdf = await buildPdfFixture(['Rechnung Seite 1']);
  const ohneFeld = await stampAndFinalize(pdf, stampData());
  const leer = await stampAndFinalize(pdf, stampData({ kommentare: [] }));
  assert.equal(await seiten(ohneFeld), 2);
  assert.equal(await seiten(leer), 2);
  assert.doesNotMatch(extrahierePdfText(leer), /Rückfragen und Kommentare/);
});

const verlaufMit = (n) => Array.from({ length: n }, (_, i) => ({ rolleLabel: `Schritt ${i}`, ...freigeber('Max Muster') }));

test('Abschnitt beginnt auf einer neuen Seite (+1 Seite), wenn der Verlauf die Seite füllt', async () => {
  const pdf = await buildPdfFixture(['Rechnung Seite 1']);
  // Grösster Verlauf, der gerade noch auf die Stempelseite passt (n passt, n + 1 nicht).
  let n = 1;
  while (await seiten(await stampAndFinalize(pdf, stampData({ verlauf: verlaufMit(n + 1) }))) === 2) n++;
  const ohne = await stampAndFinalize(pdf, stampData({ verlauf: verlaufMit(n) }));
  const mit = await stampAndFinalize(pdf, stampData({ verlauf: verlaufMit(n), kommentare: [kommentar('Am Ende angehängt.')] }));
  assert.equal(await seiten(ohne), 2);
  assert.equal(await seiten(mit), 3, 'genau eine zusätzliche Seite');
  const texte = seitenTexte(mit);
  assert.match(texte[1], new RegExp(`Schritt ${n - 1}`));
  assert.doesNotMatch(texte[1], /Rückfragen und Kommentare/, 'kein verwaister Titel am Ende der Stempelseite');
  assert.match(texte[2], /^\s*Rückfragen und Kommentare\s*\n/, 'Abschnitt beginnt oben auf der neuen Seite');
  assert.doesNotMatch(texte[2], /Fortsetzung/);
  assert.match(texte[2], /Am Ende angehängt\./);
});

test('Kopfzeile und Untertitel stehen nie allein am Seitenende', async () => {
  const pdf = await buildPdfFixture(['Rechnung Seite 1']);
  const kommentare = Array.from({ length: 3 }, (_, i) => kommentar(`Text ${i}`));
  let gepruefteUmbrueche = 0;
  // Verschiedene Verlauf-Längen schieben die Kommentare über alle Positionen am Seitenende.
  for (let n = 20; n <= 40; n++) {
    const einzel = await stampAndFinalize(pdf, stampData({ verlauf: verlaufMit(n), kommentare }));
    const gruppe = await stampGruppenDokument(pdf, {
      jobId: 7, verlauf: verlaufMit(n), positionen: [position({ jobId: 8, kommentare: kommentare.slice(0, 1) }), position({ jobId: 9, kommentare: kommentare.slice(1) })],
    });
    for (const bytes of [einzel, gruppe]) {
      const texte = seitenTexte(bytes);
      for (const seite of texte.slice(0, -1)) {
        gepruefteUmbrueche++;
        const zeile = letzteZeile(seite);
        assert.doesNotMatch(zeile, KOPFZEILE, `Kopfzeile verwaist (Verlauf ${n})`);
        assert.doesNotMatch(zeile, /— Job-ID \d+$/, `Untertitel verwaist (Verlauf ${n})`);
        assert.notEqual(zeile, 'Rückfragen und Kommentare', `Titel verwaist (Verlauf ${n})`);
      }
    }
  }
  assert.ok(gepruefteUmbrueche > 0);
});

function position(overrides = {}) {
  return {
    kontoNummer: '6500', kontoBezeichnung: 'Unterhalt', betrag: '60.00', position: 'Pos. 1',
    freigeber1: freigeber('Max Muster'), freigeber2: freigeber('Erika Beispiel'), ...overrides,
  };
}

test('stampGruppenDokument druckt Kommentare je Teil mit Untertitel (Position, Job-ID)', async () => {
  const pdf = await buildPdfFixture(['Rechnung Seite 1']);
  const stamped = await stampGruppenDokument(pdf, {
    jobId: 7,
    verlauf: [],
    kommentare: [kommentar('Rückfrage zur Gesamtrechnung')],
    positionen: [
      position({ jobId: 8, kommentare: [kommentar('Frage zu Teil eins')] }),
      position({ jobId: 9, position: 'Pos. 2', kontoNummer: '6600' }),
      position({ jobId: 10, position: null, kontoNummer: '6700', kommentare: [kommentar('Antwort zu Teil drei 😀')] }),
    ],
  });
  const text = extrahierePdfText(stamped);
  assert.match(text, /Rückfragen und Kommentare/);
  assert.match(text, /Gesamtbeleg — Job-ID 7/);
  assert.match(text, /Rückfrage zur Gesamtrechnung/);
  assert.match(text, /Position 1 \(Pos\. 1\) — Konto 6500 — Job-ID 8/);
  assert.match(text, /Frage zu Teil eins/);
  assert.doesNotMatch(text, /Job-ID 9/, 'Teil ohne Kommentare bekommt keinen Untertitel');
  assert.match(text, /Position 3 — Konto 6700 — Job-ID 10/);
  assert.match(text, /Antwort zu Teil drei \?/);
  assert.ok(text.indexOf('Frage zu Teil eins') < text.indexOf('Antwort zu Teil drei'));
});

test('stampGruppenDokument ohne Kommentare: kein Abschnitt, gleiche Seitenzahl', async () => {
  const pdf = await buildPdfFixture(['Rechnung Seite 1']);
  const daten = { jobId: 7, verlauf: [], positionen: [position({ jobId: 8, kommentare: [] }), position({ jobId: 9 })] };
  const stamped = await stampGruppenDokument(pdf, daten);
  assert.equal(await seiten(stamped), 2);
  assert.doesNotMatch(extrahierePdfText(stamped), /Rückfragen und Kommentare/);
});
