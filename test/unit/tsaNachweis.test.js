import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { extractTimestamps } from 'pdf-rfc3161';
import * as asn1js from 'asn1js';
import { openDatabase } from '../../src/db/index.js';
import { setConfigValue } from '../../src/db/adminConfigRepo.js';
import { createJob, getJobById } from '../../src/db/jobsRepo.js';
import { setZeitstempelMitNachweis } from '../../src/services/zeitstempel.js';
import { speichereTsaNachweis, ladeTsaNachweis } from '../../src/services/tsaNachweis.js';
import { runZeitstempelNachholenJob } from '../../src/services/cronJobs.js';
import { createChainedTsa } from '../helpers/chainedTsa.js';
import { setupMockTsa, signedTsaResponse } from '../helpers/mockTsa.js';
import { buildPdfFixture } from '../helpers/pdfFixture.js';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const pemToDer = (pem) => [...pem.matchAll(/-----BEGIN X509 CRL-----([A-Za-z0-9+/=\r\n]+)-----END X509 CRL-----/g)].map((m) => Buffer.from(m[1], 'base64'));

async function stempelMitKette(t) {
  const tsa = createChainedTsa(t);
  const client = setupMockTsa('https://tsa.example.org/tsr');
  client.intercept({ path: '/tsr', method: 'POST' }).reply(200, tsa.reply);
  const vorher = Date.now();
  const ergebnis = await setZeitstempelMitNachweis(await buildPdfFixture(['nachweis']), {
    url: 'https://tsa.example.org/tsr', trustAnchorsFile: tsa.rootFile, trustAnchorsSha256: tsa.rootSha256, crlFile: tsa.crlFile,
  });
  return { tsa, ...ergebnis, vorher };
}

test('trusted stamping returns the chain, the CRLs actually used, the check time and the token binding', async (t) => {
  const { tsa, stamped, nachweis, vorher } = await stempelMitKette(t);
  const { daten, objekte } = nachweis;
  assert.equal(daten.kettenpruefung, 'geprueft');
  assert.equal(daten.sperrpruefung, 'crl_zum_pruefzeitpunkt');
  assert.equal(daten.truststoreSha256, tsa.rootSha256);
  assert.deepEqual(daten.zertifikate.map((z) => z.rolle), ['signer', 'zwischen', 'vertrauensanker']);
  assert.ok(Date.parse(daten.pruefzeitpunkt) >= vorher - 1000 && Date.parse(daten.pruefzeitpunkt) <= Date.now());
  assert.match(daten.grenzen, /Keine historische Langzeitvalidierung/);
  // CRL evidence is kept byte-exact as provisioned, with its validity window.
  const crlDers = pemToDer(readFileSync(tsa.crlFile, 'utf8'));
  assert.deepEqual(daten.sperrlisten.map((s) => s.sha256).sort(), crlDers.map(sha).sort());
  for (const eintrag of daten.sperrlisten) assert.ok(Date.parse(eintrag.thisUpdate) <= Date.parse(daten.pruefzeitpunkt) && Date.parse(daten.pruefzeitpunkt) < Date.parse(eintrag.nextUpdate));
  // The root certificate evidence is the configured trust anchor.
  const rootDer = Buffer.from(readFileSync(tsa.rootFile, 'utf8').replace(/-----[^-]+-----|\s/g, ''), 'base64');
  assert.equal(daten.zertifikate.at(-1).sha256, sha(rootDer));
  // The token in the evidence is exactly the one embedded in the PDF.
  // The signature slot is zero-padded after the DER token; compare the DER-encoded part only.
  const [eingebettet] = await extractTimestamps(stamped);
  const bytes = Buffer.from(eingebettet.token);
  const laenge = asn1js.fromBER(Uint8Array.from(bytes).buffer).offset;
  assert.equal(daten.tokenSha256, sha(bytes.subarray(0, laenge)));
  for (const objekt of objekte) assert.equal(sha(objekt.der), objekt.sha256);
});

test('evidence is stored with its document, deduplicated, verifiable and immutable', async (t) => {
  const { nachweis } = await stempelMitKette(t);
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const jobId = createJob(db, { eingangAm: '2026-09-29T00:00:00Z', quelle: 'scanner', dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  const zweiter = createJob(db, { eingangAm: '2026-09-29T00:00:00Z', quelle: 'scanner', dateiname: 'b.pdf', pdfPfad: '/tmp/b.pdf' });
  assert.throws(() => speichereTsaNachweis(db, { jobId, bezug: 'einzel', dokumentSha256: 'a'.repeat(64), nachweis }), /gemeinsam/);
  db.exec('BEGIN');
  speichereTsaNachweis(db, { jobId, bezug: 'einzel', dokumentSha256: 'a'.repeat(64), nachweis });
  speichereTsaNachweis(db, { jobId: zweiter, bezug: 'einzel', dokumentSha256: 'b'.repeat(64), nachweis });
  db.exec('COMMIT');
  assert.equal(db.prepare('SELECT count(*) AS n FROM tsa_evidenz_objekte').get().n, nachweis.objekte.length);
  const geladen = ladeTsaNachweis(db, { jobId, bezug: 'einzel', dokumentSha256: 'a'.repeat(64) });
  assert.equal(geladen.integritaet, 'lokal_konsistent');
  assert.equal(geladen.geprueft_am, nachweis.daten.pruefzeitpunkt);
  assert.equal(ladeTsaNachweis(db, { jobId, bezug: 'gruppe', dokumentSha256: 'a'.repeat(64) }), null);
  db.exec('BEGIN');
  assert.throws(() => speichereTsaNachweis(db, { jobId, bezug: 'einzel', dokumentSha256: 'a'.repeat(64), nachweis }), /UNIQUE/);
  db.exec('ROLLBACK');
  for (const sql of ["UPDATE tsa_pruefnachweise SET nachweis = '{}'", 'DELETE FROM tsa_pruefnachweise', "UPDATE tsa_evidenz_objekte SET der = x'00'", 'DELETE FROM tsa_evidenz_objekte']) {
    assert.throws(() => db.exec(sql), /unveraenderlich/);
  }
  const manipuliert = { ...nachweis, objekte: [{ ...nachweis.objekte[0], der: Buffer.from('falsch') }] };
  db.exec('BEGIN');
  assert.throws(() => speichereTsaNachweis(db, { jobId, bezug: 'gruppe', dokumentSha256: 'c'.repeat(64), nachweis: manipuliert }), /Hash/);
  db.exec('ROLLBACK');
});

async function nachholFall(t) {
  const db = openDatabase(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'tsa-nachweis-retry-'));
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const pdfPfad = join(dir, 'job-1.pdf');
  writeFileSync(pdfPfad, await buildPdfFixture(['Rechnung']));
  const id = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', dateiname: 'a.pdf', pdfPfad });
  db.prepare("UPDATE jobs SET status = 'abgeschlossen', zeitstempel_erforderlich = 1 WHERE id = ?").run(id);
  setConfigValue(db, 'zeitstempel_tsa_url', 'https://tsa.example.org/tsr');
  const client = setupMockTsa('https://tsa.example.org/tsr');
  client.intercept({ path: '/tsr', method: 'POST' }).reply(200, signedTsaResponse);
  return { db, id, pdfPfad };
}

test('retry job commits the timestamp hash only together with its evidence record', async (t) => {
  const { db, id } = await nachholFall(t);
  const result = await runZeitstempelNachholenJob(db, { tsaTrustRequired: false });
  assert.equal(result.nachgeholt, 1);
  const job = getJobById(db, id);
  const geladen = ladeTsaNachweis(db, { jobId: id, bezug: 'einzel', dokumentSha256: job.zeitstempel_datei_hash });
  assert.equal(geladen.integritaet, 'lokal_konsistent');
  // Without configured anchors the record says so explicitly instead of implying trust.
  assert.equal(geladen.kettenpruefung, 'nicht_konfiguriert');
  assert.equal(geladen.daten.sperrpruefung, 'nicht_geprueft');
  assert.equal(geladen.daten.truststoreSha256, null);
});

test('failing evidence storage keeps the job unstamped and export-locked (fail-closed)', async (t) => {
  const { db, id, pdfPfad } = await nachholFall(t);
  db.exec("CREATE TRIGGER nachweis_ausfall BEFORE INSERT ON tsa_pruefnachweise BEGIN SELECT RAISE(ABORT, 'evidence store down'); END;");
  const originalError = console.error;
  console.error = () => {};
  let result;
  try { result = await runZeitstempelNachholenJob(db, { tsaTrustRequired: false }); } finally { console.error = originalError; }
  assert.equal(result.fehlgeschlagen, 1);
  const job = getJobById(db, id);
  assert.equal(job.zeitstempel_gesetzt_am, null);
  assert.equal(job.zeitstempel_datei_hash, null);
  assert.equal(job.pdf_pfad, pdfPfad);
  assert.equal(job.zeitstempel_erforderlich, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM tsa_evidenz_objekte').get().n, 0);
});
