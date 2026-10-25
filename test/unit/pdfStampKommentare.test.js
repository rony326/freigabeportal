import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
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

test('winAnsiSicher erhält Umlaute, ß, € und typografische Zeichen, ersetzt den Rest durch ?', () => {
  assert.equal(winAnsiSicher('Grüße äöü ÄÖÜ ß 12 € – „gut“ …'), 'Grüße äöü ÄÖÜ ß 12 € – „gut“ …');
  assert.equal(winAnsiSicher('ok 😀 Привет'), 'ok ? ??????');
  assert.equal(winAnsiSicher('a\tb\u0007c'), 'a b?c');
  assert.equal(winAnsiSicher('Zeile 1\r\nZeile 2\rZeile 3\nZeile 4'), 'Zeile 1\nZeile 2\nZeile 3\nZeile 4');
  assert.equal(winAnsiSicher('Müller'), 'Müller', 'zerlegte Umlaute werden per NFC zusammengesetzt');
  assert.equal(winAnsiSicher(null), '');
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
  assert.ok(ohneUmbrueche(extrahierePdfText(stamped)).includes(wort), 'kein Zeichen des langen Worts fehlt');
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

test('Abschnitt beginnt auf einer neuen Seite, wenn der Verlauf die Seite füllt', async () => {
  const pdf = await buildPdfFixture(['Rechnung Seite 1']);
  const verlauf = Array.from({ length: 36 }, (_, i) => ({ rolleLabel: `Schritt ${i}`, ...freigeber('Max Muster') }));
  const stamped = await stampAndFinalize(pdf, stampData({ verlauf, kommentare: [kommentar('Am Ende angehängt.')] }));
  const text = extrahierePdfText(stamped);
  assert.match(text, /Schritt 35/);
  assert.match(text, /Am Ende angehängt\./);
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
