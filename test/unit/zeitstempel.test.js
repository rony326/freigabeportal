import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { setupMockTsa, signedTsaResponse } from '../helpers/mockTsa.js';
import { buildPdfFixture } from '../helpers/pdfFixture.js';
import { setZeitstempel as timestampWithTrust, verifyZeitstempel } from '../../src/services/zeitstempel.js';
import * as asn1js from 'asn1js';
import { TimeStampReq, TimeStampResp, SignedData } from 'pkijs';

const RFC3161_RESPONSE = readFileSync(new URL('../fixtures/rfc3161-response.der', import.meta.url));
const RFC3161_TIMESTAMPED_PDF = readFileSync(new URL('../fixtures/rfc3161-timestamped.pdf', import.meta.url));
const FIXTURE_TEXT = 'RFC3161 Testfixtur, feste Bytes für reproduzierbaren Zeitstempel-Test.';

// These tests isolate response integrity; mandatory chain validation is covered in tsaTrust.test.js.
const setZeitstempel = (pdf, config) => timestampWithTrust(pdf, { requireTrustedChain: false, ...config });

for (const attack of ['wrong-nonce', 'missing-nonce', 'wrong-imprint', 'wrong-algorithm', 'bad-signature', 'warning-status', 'replayed-response', 'malformed']) {
  test(`setZeitstempel rejects ${attack} instead of returning a stamped PDF`, async () => {
    const client = setupMockTsa('https://tsa.example.org/tsr');
    client.intercept({ path: '/tsr', method: 'POST' }).reply(200, ({ body }) => {
      if (attack === 'replayed-response') return RFC3161_RESPONSE;
      if (attack === 'malformed') return Buffer.from('not an ASN.1 response');
      const req = new TimeStampReq({ schema: asn1js.fromBER(Uint8Array.from(body).buffer).result });
      if (attack === 'wrong-nonce') req.nonce = new asn1js.Integer({ value: 42 });
      if (attack === 'missing-nonce') delete req.nonce;
      if (attack === 'wrong-imprint') req.messageImprint.hashedMessage.valueBlock.valueHexView[0] ^= 1;
      if (attack === 'wrong-algorithm') {
        req.messageImprint.hashAlgorithm.algorithmId = '2.16.840.1.101.3.4.2.2';
        req.messageImprint.hashedMessage = new asn1js.OctetString({ valueHex: new Uint8Array(48).buffer });
      }
      const signed = signedTsaResponse({ body: new Uint8Array(req.toSchema().toBER(false)) });
      const response = new TimeStampResp({ schema: asn1js.fromBER(Uint8Array.from(signed).buffer).result });
      if (attack === 'warning-status') response.status.status = 4;
      if (attack === 'bad-signature') {
        const data = new SignedData({ schema: response.timeStampToken.content });
        data.signerInfos[0].signature.valueBlock.valueHexView[0] ^= 1;
        response.timeStampToken.content = data.toSchema();
      }
      return Buffer.from(response.toSchema().toBER(false));
    }, { headers: { 'content-type': 'application/timestamp-reply' } });
    const pdf = await buildPdfFixture([FIXTURE_TEXT]);
    const expected = {
      'wrong-nonce': /Nonce/, 'missing-nonce': /Nonce/, 'wrong-imprint': /Dokumenthash/,
      'wrong-algorithm': /Dokumenthash/, 'bad-signature': /TSA-Signatur/,
      'warning-status': /erfolgreichen Zeitstempel/, 'replayed-response': /Dokumenthash/,
      malformed: /Zeitstempel konnte nicht gesetzt werden/,
    };
    await assert.rejects(() => setZeitstempel(pdf, { url: 'https://tsa.example.org/tsr' }), expected[attack]);
  });
}

test('setZeitstempel embeds a timestamp token received from the configured TSA', async () => {
  const client = setupMockTsa('https://tsa.example.org/tsr');
  client.intercept({ path: '/tsr', method: 'POST' }).reply(200, signedTsaResponse, { headers: { 'content-type': 'application/timestamp-reply' } });

  const original = await buildPdfFixture([FIXTURE_TEXT]);
  const stamped = await setZeitstempel(original, { url: 'https://tsa.example.org/tsr' });

  assert.ok(Buffer.isBuffer(stamped));
  assert.ok(stamped.length > original.length, 'the timestamped PDF must be larger than the original');
  const result = await verifyZeitstempel(stamped);
  assert.equal(result.vorhanden, true, 'a timestamp structure must be present in the output');
  assert.equal(result.gueltig, true, 'the response must actually sign this PDF');
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
  }).reply(200, signedTsaResponse, { headers: { 'content-type': 'application/timestamp-reply' } });

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
  }).reply(200, signedTsaResponse, { headers: { 'content-type': 'application/timestamp-reply' } });

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

test('verifyZeitstempel reports vorhanden:false for a PDF with no timestamp, and still computes dateiHash', async () => {
  const plain = await buildPdfFixture(['Kein Zeitstempel hier.']);
  const result = await verifyZeitstempel(plain);
  assert.equal(result.vorhanden, false);
  assert.equal(result.gueltig, false);
  assert.equal(result.zeitpunkt, null);
  assert.equal(result.tsaPolicy, null);
  assert.equal(result.dateiHash, createHash('sha256').update(plain).digest('hex'));
  assert.equal(result.hashUebereinstimmung, null, 'no erwarteterHash was given, so there is nothing to compare');
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

test('verifyZeitstempel reports hashUebereinstimmung:true when the given hash matches the file', async () => {
  const erwarteterHash = createHash('sha256').update(RFC3161_TIMESTAMPED_PDF).digest('hex');
  const result = await verifyZeitstempel(RFC3161_TIMESTAMPED_PDF, erwarteterHash);
  assert.equal(result.dateiHash, erwarteterHash);
  assert.equal(result.hashUebereinstimmung, true);
});

test('verifyZeitstempel reports hashUebereinstimmung:false when the given hash does not match the file', async () => {
  const result = await verifyZeitstempel(RFC3161_TIMESTAMPED_PDF, 'ein-falscher-hash');
  assert.equal(result.hashUebereinstimmung, false);
});

test('verifyZeitstempel reports hashUebereinstimmung:null when no erwarteterHash is given at all', async () => {
  const result = await verifyZeitstempel(RFC3161_TIMESTAMPED_PDF);
  assert.equal(result.hashUebereinstimmung, null);
});

test('verifyZeitstempel rejects trailing bytes outside the signed revision', async () => {
  const extended = Buffer.concat([RFC3161_TIMESTAMPED_PDF, Buffer.from('\n% unsigned addition\n')]);
  const result = await verifyZeitstempel(extended);
  assert.equal(result.vorhanden, true);
  assert.equal(result.gueltig, false);
  assert.equal(result.vollstaendig, false);
});

test('a valid signature alone does not claim a trusted TSA certificate', async () => {
  const result = await verifyZeitstempel(RFC3161_TIMESTAMPED_PDF);
  assert.equal(result.signaturGueltig, true);
  assert.equal(result.vertrauen, 'nicht_geprueft');
});
