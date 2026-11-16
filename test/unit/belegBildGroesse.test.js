import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBelegPdf, mergeBelegInPdf, pruefeBelegBild, MAX_BILD_MEGAPIXEL } from '../../src/services/belegAnhaengen.js';
import { buildPdfFixture } from '../helpers/pdfFixture.js';
import { PNG_1X1, JPEG_1X1, buildSolidPng, pngChunk } from '../helpers/imageFixture.js';

// PNG mit den gewünschten Massen im Kopf: Signatur, IHDR, ein leeres IDAT und IEND mit gültigen Prüfsummen.
// So braucht der Test kein echtes Riesenbild; die Struktur ist vollständig, nur die Bilddaten sind leer.
function pngMitMassen(breite, hoehe) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(breite, 0);
  ihdr.writeUInt32BE(hoehe, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ihdr), pngChunk('IDAT', Buffer.alloc(0)), pngChunk('IEND', Buffer.alloc(0))]);
}

// JPEG-Kopf: SOI, ein APP0-Segment, ein DHT-Segment (dessen Nutzbytes wie Masse aussehen), dann der SOF-Marker.
function jpegMitMassen(breite, hoehe, sofMarker = 0xc0) {
  const app0 = Buffer.concat([Buffer.from([0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF\0\x01\x01\x00\x00\x01\x00\x01\x00\x00')]);
  const dhtNutz = Buffer.from([0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x01, 0x00, 0x01]);
  const dht = Buffer.concat([Buffer.from([0xff, 0xc4, 0x00, dhtNutz.length + 2]), dhtNutz]);
  const sof = Buffer.alloc(19);
  sof[0] = 0xff;
  sof[1] = sofMarker;
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(hoehe, 5);
  sof.writeUInt16BE(breite, 7);
  sof[9] = 3;
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, dht, sof]);
}

test('die Obergrenze beträgt 40 Megapixel', () => {
  assert.equal(MAX_BILD_MEGAPIXEL, 40);
});

test('ein PNG über 40 Megapixel wird anhand des Kopfes abgelehnt', () => {
  const fehler = pruefeBelegBild(pngMitMassen(14000, 14000), 'image/png');
  assert.match(fehler, /Megapixel/);
});

test('ein PNG genau auf der Grenze (8000 x 5000) ist erlaubt, eines knapp darüber nicht', () => {
  assert.equal(pruefeBelegBild(pngMitMassen(8000, 5000), 'image/png'), null);
  assert.match(pruefeBelegBild(pngMitMassen(8001, 5000), 'image/png'), /Megapixel/);
});

test('ein JPEG über 40 Megapixel wird abgelehnt, auch bei progressivem SOF2 und nach DHT-Segment', () => {
  assert.match(pruefeBelegBild(jpegMitMassen(10000, 5000, 0xc0), 'image/jpeg'), /Megapixel/);
  assert.match(pruefeBelegBild(jpegMitMassen(10000, 5000, 0xc2), 'image/jpeg'), /Megapixel/);
});

test('ein JPEG mit normalen Massen wird nicht von einem DHT-Segment (0xC4) irritiert', () => {
  assert.equal(pruefeBelegBild(jpegMitMassen(3000, 4000, 0xc0), 'image/jpeg'), null);
});

test('echte kleine Bilder bestehen die Prüfung', () => {
  assert.equal(pruefeBelegBild(PNG_1X1, 'image/png'), null);
  assert.equal(pruefeBelegBild(JPEG_1X1, 'image/jpeg'), null);
  assert.equal(pruefeBelegBild(buildSolidPng(300, 200), 'image/png'), null);
});

test('PDF-Belege werden von der Bildprüfung nicht berührt', async () => {
  assert.equal(pruefeBelegBild(await buildPdfFixture(['x']), 'application/pdf'), null);
});

test('ein Bild, dessen Masse nicht lesbar sind, wird abgelehnt statt ungeprüft eingebettet', () => {
  assert.match(pruefeBelegBild(pngMitMassen(14000, 14000).subarray(0, 20), 'image/png'), /gelesen/);
  assert.match(pruefeBelegBild(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]), 'image/jpeg'), /gelesen/);
  assert.match(pruefeBelegBild(Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from([0xff, 0xda, 0x00, 0x02])]), 'image/jpeg'), /gelesen/);
  assert.match(pruefeBelegBild(pngMitMassen(0, 10), 'image/png'), /gelesen/);
});

test('buildBelegPdf und mergeBelegInPdf lehnen ein Riesenbild ab, bevor sie es dekodieren', async () => {
  await assert.rejects(buildBelegPdf(pngMitMassen(14000, 14000), 'image/png'), /Megapixel/);
  await assert.rejects(buildBelegPdf(jpegMitMassen(10000, 5000), 'image/jpeg'), /Megapixel/);
  const pdf = await buildPdfFixture(['x']);
  await assert.rejects(mergeBelegInPdf(pdf, pngMitMassen(14000, 14000), 'image/png'), /Megapixel/);
});

// Befund 2026-11-16: Ein abgeschnittenes PNG liess pdf-lib (embedPng) endlos hängen – im PDF-Worker bis zum Zeitlimit,
// bei jedem neuen Versuch wieder. Die Bildprüfung verlangt darum eine vollständige Chunk-Struktur (IHDR … IDAT … IEND,
// jede Länge passt in die Datei, Prüfsummen stimmen).
test('ein abgeschnittenes PNG wird abgelehnt, egal an welcher Stelle es endet', () => {
  const voll = buildSolidPng(40, 40);
  for (let laenge = 24; laenge < voll.length; laenge++) {
    assert.match(pruefeBelegBild(voll.subarray(0, laenge), 'image/png') ?? 'durchgelassen', /gelesen/, `abgeschnitten auf ${laenge} Bytes`);
  }
  assert.equal(pruefeBelegBild(voll, 'image/png'), null);
});

test('ein PNG mit beschädigter Prüfsumme, ohne IDAT oder mit Daten vor IHDR wird abgelehnt', () => {
  const voll = buildSolidPng(40, 40);
  const kaputt = Buffer.from(voll);
  kaputt[45] ^= 0xff; // ein Byte in den IDAT-Daten
  assert.match(pruefeBelegBild(kaputt, 'image/png'), /gelesen/);
  const ihdr = voll.subarray(8, 33);
  const iend = voll.subarray(voll.length - 12);
  assert.match(pruefeBelegBild(Buffer.concat([voll.subarray(0, 8), ihdr, iend]), 'image/png'), /gelesen/);
  const text = pngChunk('tEXt', Buffer.from('a\0b'));
  assert.match(pruefeBelegBild(Buffer.concat([voll.subarray(0, 8), text, voll.subarray(8)]), 'image/png'), /gelesen/);
});
