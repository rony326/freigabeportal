import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, symlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase } from '../../src/db/index.js';
import { setConfigValue } from '../../src/db/adminConfigRepo.js';
import { X509Certificate } from 'node:crypto';
import * as asn1js from 'asn1js';
import { Certificate } from 'pkijs';
import { loadTsaCrls, verifyTsaRevocation } from '../../src/services/tsaRevocation.js';
import { aktualisiereTsaCrls, runTsaCrlAktualisierungJob, WARNFRIST_MS } from '../../src/services/tsaCrlUpdate.js';
import { setupMockTsa, signedTsaResponse } from '../helpers/mockTsa.js';
import { createChainedTsa } from '../helpers/chainedTsa.js';

const TSA_URL = 'https://tsa.example.org/tsr';

const pemZuDer = (pem) => Buffer.from(pem.toString().replace(/-----[A-Z0-9 ]+-----|\s/g, ''), 'base64');

// Liefert die aktuell im Testverzeichnis erzeugten CRLs unter den Verteilpunkten der Testkette aus.
function crlServer(tsa, ueberschreiben = {}) {
  const abgerufen = [];
  const holeUrl = async (url) => {
    abgerufen.push(url);
    if (ueberschreiben[url]) return ueberschreiben[url]();
    const name = { 'http://crl.example.org/root.crl': 'root', 'http://crl.example.org/intermediate.crl': 'intermediate' }[url];
    if (!name) throw new Error(`unerwartete URL ${url}`);
    return pemZuDer(readFileSync(join(tsa.dir, `${name}.crl.pem`)));
  };
  return { holeUrl, abgerufen };
}

function tsaConfig(tsa, crlFile = join(tsa.dir, 'ziel-crls.pem')) {
  return { url: TSA_URL, trustAnchorsFile: tsa.rootFile, trustAnchorsSha256: tsa.rootSha256, crlFile };
}

function mockTsa(reply) {
  setupMockTsa(TSA_URL).intercept({ path: '/tsr', method: 'POST' }).reply(200, reply);
}

test('renews the CRL file from the distribution points of the validated chain', async (t) => {
  const tsa = createChainedTsa(t);
  mockTsa(tsa.reply);
  const { holeUrl, abgerufen } = crlServer(tsa);
  const config = tsaConfig(tsa);
  const result = await aktualisiereTsaCrls(config, { holeUrl });
  assert.deepEqual(abgerufen.sort(), ['http://crl.example.org/intermediate.crl', 'http://crl.example.org/root.crl']);
  assert.equal(loadTsaCrls(config.crlFile).length, 2);
  assert.equal(result.sperrlisten.length, 2);
  assert.ok(result.naechsterAblauf instanceof Date && result.naechsterAblauf > new Date());
});

test('an invalid downloaded CRL leaves the existing file untouched', async (t) => {
  const tsa = createChainedTsa(t);
  const fremd = createChainedTsa(t);
  const config = tsaConfig(tsa);
  writeFileSync(config.crlFile, readFileSync(tsa.crlFile));
  const vorher = readFileSync(config.crlFile);
  mockTsa(tsa.reply);
  const { holeUrl } = crlServer(tsa, {
    'http://crl.example.org/intermediate.crl': () => pemZuDer(readFileSync(join(fremd.dir, 'intermediate.crl.pem'))),
  });
  await assert.rejects(() => aktualisiereTsaCrls(config, { holeUrl }), /Signatur/);
  assert.deepEqual(readFileSync(config.crlFile), vorher);
});

test('a download failure leaves the existing file untouched', async (t) => {
  const tsa = createChainedTsa(t);
  const config = tsaConfig(tsa);
  writeFileSync(config.crlFile, readFileSync(tsa.crlFile));
  const vorher = readFileSync(config.crlFile);
  mockTsa(tsa.reply);
  const { holeUrl } = crlServer(tsa, { 'http://crl.example.org/root.crl': () => { throw new Error('HTTP 503'); } });
  await assert.rejects(() => aktualisiereTsaCrls(config, { holeUrl }), /503/);
  assert.deepEqual(readFileSync(config.crlFile), vorher);
});

test('authentic CRLs revoking the TSA are stored so new timestamps stay blocked', async (t) => {
  // Sonst blieben alte, noch gueltige Listen ohne Sperrung aktiv und die Sperrung wuerde unterdrueckt.
  const tsa = createChainedTsa(t);
  const config = tsaConfig(tsa);
  writeFileSync(config.crlFile, readFileSync(tsa.crlFile));
  const kette = ['signer', 'intermediate', 'root'].map((name) => {
    const cert = new X509Certificate(readFileSync(join(tsa.dir, `${name}.pem`)));
    return new Certificate({ schema: asn1js.fromBER(Uint8Array.from(cert.raw).buffer).result });
  });
  await verifyTsaRevocation(kette, loadTsaCrls(config.crlFile));
  tsa.writeCrlBundle({ revoke: ['signer'] });
  mockTsa(tsa.reply);
  await assert.rejects(() => aktualisiereTsaCrls(config, crlServer(tsa)), /gesperrt/);
  await assert.rejects(() => verifyTsaRevocation(kette, loadTsaCrls(config.crlFile)), /gesperrt/, 'revoking CRLs replace the old file');
});

test('an untrusted TSA chain is rejected before any CRL is downloaded', async (t) => {
  const tsa = createChainedTsa(t);
  mockTsa(signedTsaResponse);
  const server = crlServer(tsa);
  await assert.rejects(() => aktualisiereTsaCrls(tsaConfig(tsa), server), /Kette/);
  assert.deepEqual(server.abgerufen, []);
});

test('a symlinked CRL target is refused', async (t) => {
  const tsa = createChainedTsa(t);
  const link = join(tsa.dir, 'link-crls.pem');
  symlinkSync(tsa.crlFile, link);
  mockTsa(tsa.reply);
  await assert.rejects(() => aktualisiereTsaCrls(tsaConfig(tsa, link), crlServer(tsa)), /Symlink|regulaere Datei/);
});

function jobSetup(t, { tsaUrl = TSA_URL } = {}) {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  setConfigValue(db, 'sicherheitsalarm_empfaenger', 'alarm@example.org');
  if (tsaUrl) setConfigValue(db, 'zeitstempel_tsa_url', tsaUrl);
  const mails = [];
  return { db, mails, mailer: { async sendMail(mail) { mails.push(mail); } } };
}

function jobConfig(tsa, crlFile) {
  return {
    publicBaseUrl: 'https://portal.example.org', churchtools: { groupIdAdmin: '20', groupIdBuchhaltung: '10' },
    tsaCrlAutoUpdate: true, tsaTrustAnchorsFile: tsa.rootFile, tsaTrustAnchorsSha256: tsa.rootSha256, tsaCrlFile: crlFile,
  };
}

test('job is skipped unless auto update and a TSA URL are configured', async (t) => {
  const tsa = createChainedTsa(t);
  const { db, mailer } = jobSetup(t);
  assert.equal((await runTsaCrlAktualisierungJob(db, { ...jobConfig(tsa, tsa.crlFile), tsaCrlAutoUpdate: false }, mailer)).status, 'uebersprungen');
  const ohneUrl = jobSetup(t, { tsaUrl: null });
  assert.equal((await runTsaCrlAktualisierungJob(ohneUrl.db, jobConfig(tsa, tsa.crlFile), ohneUrl.mailer)).status, 'uebersprungen');
});

test('successful job run renews the file without alarm', async (t) => {
  const tsa = createChainedTsa(t);
  const { db, mailer, mails } = jobSetup(t);
  const crlFile = join(tsa.dir, 'ziel-crls.pem');
  mockTsa(tsa.reply);
  const result = await runTsaCrlAktualisierungJob(db, jobConfig(tsa, crlFile), mailer, crlServer(tsa));
  assert.equal(result.status, 'erfolg');
  assert.ok(existsSync(crlFile));
  assert.equal(mails.length, 0);
});

test('failed run alarms only when the current CRLs are missing or expire within the warning period', async (t) => {
  const tsa = createChainedTsa(t);
  const crlFile = join(tsa.dir, 'ziel-crls.pem');
  writeFileSync(crlFile, readFileSync(tsa.crlFile));
  const kaputt = { holeUrl: async () => { throw new Error('HTTP 503'); } };

  const weitWeg = jobSetup(t);
  mockTsa(tsa.reply);
  const ablauf = loadTsaCrls(crlFile)[0].nextUpdate.value.getTime();
  const ruhig = await runTsaCrlAktualisierungJob(weitWeg.db, jobConfig(tsa, crlFile), weitWeg.mailer, { ...kaputt, jetzt: ablauf - WARNFRIST_MS - 60_000 });
  assert.equal(ruhig.status, 'fehler');
  assert.equal(weitWeg.mails.length, 0);

  const knapp = jobSetup(t);
  mockTsa(tsa.reply);
  const laut = await runTsaCrlAktualisierungJob(knapp.db, jobConfig(tsa, crlFile), knapp.mailer, kaputt);
  assert.equal(laut.status, 'fehler');
  assert.equal(knapp.mails.length, 1);
  assert.match(knapp.mails[0].subject, /Sperrlisten/);
  assert.match(knapp.mails[0].text, /503/);
  assert.equal(knapp.db.prepare("SELECT COUNT(*) AS n FROM mail_log WHERE typ = 'sicherheitsalarm'").get().n, 1);

  const fehlend = jobSetup(t);
  mockTsa(tsa.reply);
  await runTsaCrlAktualisierungJob(fehlend.db, jobConfig(tsa, join(tsa.dir, 'gibt-es-nicht.pem')), fehlend.mailer, kaputt);
  assert.equal(fehlend.mails.length, 1);
});
