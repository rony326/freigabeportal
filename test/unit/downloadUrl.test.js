import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSignedDownloadUrl, verifySignedDownload } from '../../src/services/downloadUrl.js';

function testConfig() {
  return { downloadSigningSecret: 'test-signing-secret' };
}

function parseUrl(url) {
  const [, query] = url.split('?');
  const params = new URLSearchParams(query);
  return { expires: params.get('expires'), signature: params.get('signature') };
}

test('buildSignedDownloadUrl produces a path containing the job id, an expiry and a 64-char hex signature', () => {
  const url = buildSignedDownloadUrl(testConfig(), 42, 900);
  assert.match(url, /^\/downloads\/42\?/);
  const { expires, signature } = parseUrl(url);
  assert.ok(Number(expires) > Math.floor(Date.now() / 1000));
  assert.match(signature, /^[0-9a-f]{64}$/);
});

test('verifySignedDownload accepts a freshly built, unexpired URL', () => {
  const config = testConfig();
  const url = buildSignedDownloadUrl(config, 42, 900);
  const { expires, signature } = parseUrl(url);
  assert.equal(verifySignedDownload(config, 42, expires, signature), true);
});

test('verifySignedDownload rejects an expired URL even with a correct signature', () => {
  const config = testConfig();
  const url = buildSignedDownloadUrl(config, 42, -10);
  const { expires, signature } = parseUrl(url);
  assert.equal(verifySignedDownload(config, 42, expires, signature), false);
});

test('verifySignedDownload rejects a tampered signature', () => {
  const config = testConfig();
  const url = buildSignedDownloadUrl(config, 42, 900);
  const { expires } = parseUrl(url);
  assert.equal(verifySignedDownload(config, 42, expires, 'a'.repeat(64)), false);
});

test('verifySignedDownload rejects a signature built for a different job id', () => {
  const config = testConfig();
  const url = buildSignedDownloadUrl(config, 42, 900);
  const { expires, signature } = parseUrl(url);
  assert.equal(verifySignedDownload(config, 99, expires, signature), false);
});

test('verifySignedDownload rejects a missing or malformed signature without throwing', () => {
  const config = testConfig();
  assert.equal(verifySignedDownload(config, 42, String(Math.floor(Date.now() / 1000) + 900), undefined), false);
  assert.equal(verifySignedDownload(config, 42, String(Math.floor(Date.now() / 1000) + 900), 'not-hex!!'), false);
});
