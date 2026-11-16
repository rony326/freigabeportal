import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBelegPdf, mergeBelegInPdf, pruefeBelegBild, MAX_BILD_MEGAPIXEL } from '../../src/services/belegAnhaengen.js';
import { buildPdfFixture } from '../helpers/pdfFixture.js';
import { PNG_1X1, JPEG_1X1, buildSolidPng } from '../helpers/imageFixture.js';

// PNG mit gefälschtem Kopf: nur Signatur + IHDR mit den gewünschten Massen, der Rest ist Müll.
// So braucht der Test kein echtes Riesenbild; ein ungeprüfter Aufrufer würde erst im Dekodieren scheitern.
function pngMitMassen(breite, hoehe) {
  const kopf = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(kopf, 0);
  kopf.writeUInt32BE(13, 8);
  kopf.write('IHDR', 12, 'ascii');
  kopf.writeUInt32BE(breite, 16);
  kopf.writeUInt32BE(hoehe, 20);
  kopf[24] = 8;
  kopf[25] = 2;
  return kopf;
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
