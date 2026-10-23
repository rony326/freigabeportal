import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { openDatabase } from '../../src/db/index.js';
import { setConfigValue } from '../../src/db/adminConfigRepo.js';
import { stempleAuditPaket, pruefeAuditZeitstempelToken, tsaConfigAusDb } from '../../src/services/auditZeitstempel.js';
import { leseTimestampToken } from '../../src/services/tsaResponse.js';
import { setupMockTsa } from '../helpers/mockTsa.js';
import { createChainedTsa } from '../helpers/chainedTsa.js';

const TSA_URL = 'https://tsa.example.org/tsr';
const HASH = createHash('sha256').update('audit-paket-1').digest('hex');
const ANDERER_HASH = createHash('sha256').update('audit-paket-2').digest('hex');

function tsaConfig(tsa) {
  return { url: TSA_URL, trustAnchorsFile: tsa.rootFile, trustAnchorsSha256: tsa.rootSha256, crlFile: tsa.crlFile };
}

async function stempeln(t) {
  const tsa = createChainedTsa(t);
  setupMockTsa(TSA_URL).intercept({ path: '/tsr', method: 'POST' }).reply(200, tsa.reply);
  return stempleAuditPaket(HASH, tsaConfig(tsa));
}

test('stempelt eine Prüfnummer und liefert Token, Zeit und Nachweis', async (t) => {
  const vorher = Date.now();
  const ergebnis = await stempeln(t);
  assert.ok(Buffer.isBuffer(ergebnis.token));
  assert.ok(ergebnis.genTime instanceof Date);
  assert.ok(Math.abs(ergebnis.genTime.getTime() - vorher) < 60_000);
  assert.equal(typeof ergebnis.nachweis, 'object');
  assert.ok(ergebnis.nachweis);
  const pruefung = await pruefeAuditZeitstempelToken(ergebnis.token, HASH);
  assert.equal(pruefung.gueltig, true, pruefung.fehler);
  assert.equal(pruefung.fehler, null);
  assert.equal(pruefung.genTime.getTime(), ergebnis.genTime.getTime());
});

test('MessageImprint ist SHA-256 über die Hex-Zeichen der Prüfnummer', async (t) => {
  const { token } = await stempeln(t);
  const { info } = leseTimestampToken(token);
  const erwartet = createHash('sha256').update(Buffer.from(HASH, 'utf8')).digest();
  assert.deepEqual(Buffer.from(info.messageImprint.hashedMessage.getValue()), erwartet);
});

test('Token gehört nicht zu einer anderen Prüfnummer', async (t) => {
  const { token } = await stempeln(t);
  const pruefung = await pruefeAuditZeitstempelToken(token, ANDERER_HASH);
  assert.equal(pruefung.gueltig, false);
  assert.match(pruefung.fehler, /passt nicht/);
});

test('manipuliertes Token ist ungültig', async (t) => {
  const { token } = await stempeln(t);
  const manipuliert = Buffer.from(token);
  // Die Signatur steht am Ende der SignerInfo und damit am Ende des Tokens.
  manipuliert[manipuliert.length - 10] ^= 0xff;
  const pruefung = await pruefeAuditZeitstempelToken(manipuliert, HASH);
  assert.equal(pruefung.gueltig, false);
  assert.match(pruefung.fehler, /Signatur/);
});

test('unlesbares Token ist ungültig, ohne zu werfen', async () => {
  const pruefung = await pruefeAuditZeitstempelToken(Buffer.from('kein token'), HASH);
  assert.equal(pruefung.gueltig, false);
  assert.equal(pruefung.genTime, null);
  assert.ok(pruefung.fehler);
});

test('TSA-Fehler (HTTP 500) wirft verständliche Meldung', async (t) => {
  const tsa = createChainedTsa(t);
  setupMockTsa(TSA_URL).intercept({ path: '/tsr', method: 'POST' }).reply(500, '').persist();
  await assert.rejects(() => stempleAuditPaket(HASH, tsaConfig(tsa)), /Zeitstempel/);
});

test('tsaConfigAusDb liefert null ohne TSA-URL', (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  assert.equal(tsaConfigAusDb(db, {}), null);
});

test('tsaConfigAusDb baut die Konfiguration aus admin_config und Vertrauensankern', (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  setConfigValue(db, 'zeitstempel_tsa_url', TSA_URL);
  setConfigValue(db, 'zeitstempel_tsa_user', 'nutzer');
  setConfigValue(db, 'zeitstempel_tsa_passwort', 'geheim');
  const config = { tsaTrustAnchorsFile: '/anker.pem', tsaTrustAnchorsSha256: 'a'.repeat(64), tsaCrlFile: '/crls.pem' };
  assert.deepEqual(tsaConfigAusDb(db, config), {
    trustAnchorsFile: '/anker.pem', trustAnchorsSha256: 'a'.repeat(64), crlFile: '/crls.pem', requireTrustedChain: true,
    url: TSA_URL, user: 'nutzer', passwort: 'geheim',
  });
});
