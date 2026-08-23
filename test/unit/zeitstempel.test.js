import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setupMockTsa } from '../helpers/mockTsa.js';
import { buildPdfFixture } from '../helpers/pdfFixture.js';
import { setZeitstempel, verifyZeitstempel } from '../../src/services/zeitstempel.js';

const RFC3161_RESPONSE = readFileSync(new URL('../fixtures/rfc3161-response.der', import.meta.url));
const RFC3161_TIMESTAMPED_PDF = readFileSync(new URL('../fixtures/rfc3161-timestamped.pdf', import.meta.url));
const FIXTURE_TEXT = 'RFC3161 Testfixtur, feste Bytes für reproduzierbaren Zeitstempel-Test.';

test('setZeitstempel embeds a timestamp token received from the configured TSA', async () => {
  const client = setupMockTsa('https://tsa.example.org/tsr');
  client.intercept({ path: '/tsr', method: 'POST' }).reply(200, RFC3161_RESPONSE, { headers: { 'content-type': 'application/timestamp-reply' } });

  const original = await buildPdfFixture([FIXTURE_TEXT]);
  const stamped = await setZeitstempel(original, { url: 'https://tsa.example.org/tsr' });

  assert.ok(Buffer.isBuffer(stamped));
  assert.ok(stamped.length > original.length, 'the timestamped PDF must be larger than the original');
  const result = await verifyZeitstempel(stamped);
  assert.equal(result.vorhanden, true, 'a timestamp structure must be present in the output');
});

test('setZeitstempel sends Basic-Auth headers when a TSA username is configured', async () => {
  const client = setupMockTsa('https://tsa.example.org/tsr');
  let receivedAuth;
  client.intercept({
    path: '/tsr',
    method: 'POST',
    headers: (headers) => {
      receivedAuth = headers.authorization;
      return true;
    },
  }).reply(200, RFC3161_RESPONSE, { headers: { 'content-type': 'application/timestamp-reply' } });

  const original = await buildPdfFixture([FIXTURE_TEXT]);
  await setZeitstempel(original, { url: 'https://tsa.example.org/tsr', user: 'tsauser', passwort: 'geheim' });

  assert.equal(receivedAuth, `Basic ${Buffer.from('tsauser:geheim').toString('base64')}`);
});

test('setZeitstempel omits the Authorization header when no TSA username is configured', async () => {
  const client = setupMockTsa('https://tsa.example.org/tsr');
  let receivedAuth = 'not-checked';
  client.intercept({
    path: '/tsr',
    method: 'POST',
    headers: (headers) => {
      receivedAuth = headers.authorization;
      return true;
    },
  }).reply(200, RFC3161_RESPONSE, { headers: { 'content-type': 'application/timestamp-reply' } });

  const original = await buildPdfFixture([FIXTURE_TEXT]);
  await setZeitstempel(original, { url: 'https://tsa.example.org/tsr' });

  assert.equal(receivedAuth, undefined);
});

test('setZeitstempel throws a German-message Error when the TSA is unreachable', async () => {
  setupMockTsa('https://tsa.example.org/tsr'); // no .intercept() registered -> the request fails to match

  const original = await buildPdfFixture([FIXTURE_TEXT]);
  await assert.rejects(
    () => setZeitstempel(original, { url: 'https://tsa.example.org/tsr' }),
    (err) => {
      assert.match(err.message, /Zeitstempel konnte nicht gesetzt werden/);
      return true;
    }
  );
});

test('setZeitstempel throws a German-message Error when the TSA returns an HTTP error status', async () => {
  const client = setupMockTsa('https://tsa.example.org/tsr');
  client.intercept({ path: '/tsr', method: 'POST' }).reply(500, 'Internal Server Error').persist();

  const original = await buildPdfFixture([FIXTURE_TEXT]);
  await assert.rejects(
    () => setZeitstempel(original, { url: 'https://tsa.example.org/tsr' }),
    /Zeitstempel konnte nicht gesetzt werden/
  );
});

test('verifyZeitstempel reports vorhanden:false for a PDF with no timestamp', async () => {
  const plain = await buildPdfFixture(['Kein Zeitstempel hier.']);
  const result = await verifyZeitstempel(plain);
  assert.deepEqual(result, { vorhanden: false, gueltig: false, zeitpunkt: null, tsaPolicy: null });
});

test('verifyZeitstempel reports vorhanden:true, gueltig:true, and a parsed zeitpunkt for a validly timestamped PDF', async () => {
  const result = await verifyZeitstempel(RFC3161_TIMESTAMPED_PDF);
  assert.equal(result.vorhanden, true);
  assert.equal(result.gueltig, true);
  assert.equal(result.zeitpunkt, '2026-08-21T07:21:19.000Z');
  assert.equal(result.tsaPolicy, '1.2.3.4.1');
});

test('verifyZeitstempel reports gueltig:false when the PDF content was altered after timestamping', async () => {
  const tampered = Buffer.from(RFC3161_TIMESTAMPED_PDF);
  // Flip one byte well inside the first covered byte range (the timestamped fixture's own
  // byteRange starts at 0 and covers well past byte 200), so the bytes the token's digest
  // covers no longer match what they were signed against.
  tampered[200] = tampered[200] ^ 0xff;
  const result = await verifyZeitstempel(tampered);
  assert.equal(result.vorhanden, true, 'the timestamp structure is still parseable');
  assert.equal(result.gueltig, false, 'but the digest no longer matches the altered content');
});
