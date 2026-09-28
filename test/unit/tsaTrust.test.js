import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { TimestampSession, parseTimestampResponse } from 'pdf-rfc3161';
import { loadTsaTrustAnchors, verifyTsaChain, tsaTrustOptions } from '../../src/services/tsaTrust.js';
import { loadTsaCrls } from '../../src/services/tsaRevocation.js';
import { freshTimestampRequest, validateTimestampBinding } from '../../src/services/tsaResponse.js';
import { setZeitstempel, verifyZeitstempel } from '../../src/services/zeitstempel.js';
import { setupMockTsa, signedTsaResponse } from '../helpers/mockTsa.js';
import { createChainedTsa } from '../helpers/chainedTsa.js';
import { buildPdfFixture } from '../helpers/pdfFixture.js';

test('timestamping requires configured trust anchors by default', async () => {
  assert.equal(tsaTrustOptions().requireTrustedChain, true);
  await assert.rejects(() => setZeitstempel(Buffer.from('pdf'), { url: 'https://tsa.example.org' }), /Vertrauensanker/);
});

test('trust bundle parser requires pinned self-signed roots, bounded PEM and no symlinks', (t) => {
  const tsa = createChainedTsa(t);
  const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
  assert.equal(loadTsaTrustAnchors(tsa.rootFile, tsa.rootSha256).length, 1);
  assert.throws(() => loadTsaTrustAnchors(tsa.rootFile, '0'.repeat(64)), /SHA-256/);
  assert.throws(() => loadTsaTrustAnchors(tsa.rootFile), /SHA-256/);
  const leaf = readFileSync(tsa.leafFile);
  assert.throws(() => loadTsaTrustAnchors(tsa.leafFile, hash(leaf)), /CA-Zertifikat/);
  for (const bytes of [Buffer.from(''), Buffer.from('not PEM'), Buffer.concat([readFileSync(tsa.rootFile), readFileSync(tsa.rootFile)]), Buffer.alloc(129 * 1024)]) {
    const path = join(tsa.dir, 'bad.pem');
    writeFileSync(path, bytes);
    assert.throws(() => loadTsaTrustAnchors(path, hash(bytes)));
  }
  const link = join(tsa.dir, 'link.pem');
  symlinkSync(tsa.rootFile, link);
  assert.throws(() => loadTsaTrustAnchors(link, tsa.rootSha256));
});

test('valid leaf/intermediate/root chain stamps with current authenticated CRLs', async (t) => {
  const tsa = createChainedTsa(t);
  const client = setupMockTsa('https://tsa.example.org/tsr');
  client.intercept({ path: '/tsr', method: 'POST' }).reply(200, tsa.reply);
  const pdf = await setZeitstempel(await buildPdfFixture(['trusted test chain']), {
    url: 'https://tsa.example.org/tsr', trustAnchorsFile: tsa.rootFile, trustAnchorsSha256: tsa.rootSha256,
    crlFile: tsa.crlFile,
  });
  assert.equal((await verifyZeitstempel(pdf)).gueltig, true);
  assert.equal((await verifyZeitstempel(pdf)).vertrauen, 'nicht_geprueft', 'historical UI does not infer current trust from successful issuance');
});

test('a self-signed responder cannot become trusted by including its certificate', async (t) => {
  const tsa = createChainedTsa(t);
  const client = setupMockTsa('https://tsa.example.org/tsr');
  client.intercept({ path: '/tsr', method: 'POST' }).reply(200, signedTsaResponse);
  const pdf = await buildPdfFixture(['untrusted responder']);
  await assert.rejects(() => setZeitstempel(pdf, { url: 'https://tsa.example.org/tsr', trustAnchorsFile: tsa.rootFile, trustAnchorsSha256: tsa.rootSha256, crlFile: tsa.crlFile }), /Kette/);
});

test('path validation binds signer, intermediate checks and local revocation evidence', async (t) => {
  const tsa = createChainedTsa(t);
  const session = new TimestampSession(await buildPdfFixture(['chain checks']), { enableLTV: false });
  t.after(() => session.dispose());
  const request = freshTimestampRequest(await session.createTimestampRequest());
  const token = parseTimestampResponse(Uint8Array.from(tsa.reply({ body: request }))).token;
  const binding = validateTimestampBinding(request, token);
  const anchors = loadTsaTrustAnchors(tsa.rootFile, tsa.rootSha256);
  const crls = loadTsaCrls(tsa.crlFile);
  const result = await verifyTsaChain(binding, anchors, crls);
  assert.equal(result.kette, 'geprueft');
  assert.equal(result.sperrstatus, 'crl_geprueft');
  await assert.rejects(() => verifyTsaChain(binding, anchors), /Sperrlisten/);
  const certs = binding.signed.certificates;
  binding.signed.certificates = [...certs].reverse();
  assert.equal((await verifyTsaChain(binding, anchors, crls)).signerSha256, result.signerSha256);
  binding.signed.certificates = [binding.signer];
  await assert.rejects(() => verifyTsaChain(binding, anchors, crls), /Kette/);
  binding.signed.certificates = certs;
  const intermediate = certs.find((cert) => !cert.subject.isEqual(cert.issuer) && cert !== binding.signer);
  intermediate.notAfter.value = new Date('2000-01-01');
  await assert.rejects(() => verifyTsaChain(binding, anchors, crls), /Kette/);
});
