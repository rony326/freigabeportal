import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/db/index.js';
import { createJob } from '../../src/db/jobsRepo.js';
import { buildSignedDownloadUrl } from '../../src/services/downloadUrl.js';
import { createDownloadsRouter } from '../../src/routes/downloads.js';

const PDF_BYTES = Buffer.from('%PDF-1.4\n%test-fixture\n');

function buildTestApp(db, config) {
  const app = express();
  app.use('/downloads', createDownloadsRouter({ db, config }));
  return app;
}

function testConfig() {
  return { downloadSigningSecret: 'test-secret' };
}

function seedJobWithFile(db, dir) {
  const pdfPfad = join(dir, `f-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);
  writeFileSync(pdfPfad, PDF_BYTES);
  const id = createJob(db, { eingangAm: '2026-08-14T10:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad });
  return { id, pdfPfad };
}

test('a valid, unexpired signed URL serves the PDF bytes', async () => {
  const db = openDatabase(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'downloads-test-'));
  const config = testConfig();
  const { id } = seedJobWithFile(db, dir);
  const app = buildTestApp(db, config);

  const url = buildSignedDownloadUrl(config, id, 900);
  const res = await request(app).get(url);

  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'application/pdf');
  assert.equal(res.headers['content-disposition'], 'inline; filename="a.pdf"');
  assert.equal(res.headers['content-length'], String(PDF_BYTES.length));
  assert.ok(Buffer.from(res.body).equals(PDF_BYTES) || res.text === PDF_BYTES.toString());
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('Content-Disposition strips CR/LF and quotes from the filename to prevent header injection', async () => {
  const db = openDatabase(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'downloads-test-'));
  const config = testConfig();
  const pdfPfad = join(dir, `f-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);
  writeFileSync(pdfPfad, PDF_BYTES);
  const id = createJob(db, {
    eingangAm: '2026-08-14T10:00:00.000Z',
    quelle: 'scanner',
    absender: null,
    dateiname: 'evil"\r\nX-Injected: yes.pdf',
    pdfPfad,
  });
  const app = buildTestApp(db, config);

  const res = await request(app).get(buildSignedDownloadUrl(config, id, 900));

  assert.equal(res.status, 200);
  assert.equal(res.headers['content-disposition'], 'inline; filename="evilX-Injected: yes.pdf"');
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('an expired signed URL returns 403', async () => {
  const db = openDatabase(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'downloads-test-'));
  const config = testConfig();
  const { id } = seedJobWithFile(db, dir);
  const app = buildTestApp(db, config);

  const url = buildSignedDownloadUrl(config, id, -10);
  const res = await request(app).get(url);
  assert.equal(res.status, 403);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('a tampered signature returns 403 with the same message as an expired link', async () => {
  const db = openDatabase(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'downloads-test-'));
  const config = testConfig();
  const { id } = seedJobWithFile(db, dir);
  const app = buildTestApp(db, config);

  const expiredRes = await request(app).get(buildSignedDownloadUrl(config, id, -10));
  const tamperedRes = await request(app).get(`/downloads/${id}?expires=${Math.floor(Date.now() / 1000) + 900}&signature=${'a'.repeat(64)}`);

  assert.equal(tamperedRes.status, 403);
  assert.deepEqual(tamperedRes.body, expiredRes.body);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('a valid signature for a job whose file no longer exists returns the same generic 403', async () => {
  const db = openDatabase(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'downloads-test-'));
  const config = testConfig();
  const id = createJob(db, { eingangAm: '2026-08-14T10:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: join(dir, 'does-not-exist.pdf') });
  const app = buildTestApp(db, config);

  const res = await request(app).get(buildSignedDownloadUrl(config, id, 900));
  assert.equal(res.status, 403);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('a valid, unexpired signature for a job ID that was never created returns the same generic 403', async () => {
  const db = openDatabase(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'downloads-test-'));
  const config = testConfig();
  const app = buildTestApp(db, config);

  const expiredRes = await request(app).get(buildSignedDownloadUrl(config, 1, -10));
  const missingJobRes = await request(app).get(buildSignedDownloadUrl(config, 999999, 900));

  assert.equal(missingJobRes.status, 403);
  assert.deepEqual(missingJobRes.body, expiredRes.body);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('a stream error (pdf_pfad pointing at a directory) returns the same generic 403 instead of crashing', async () => {
  const db = openDatabase(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'downloads-test-'));
  const config = testConfig();
  // existsSync(dir) is true (it's a directory), so the route passes the existence check
  // and only fails when createReadStream actually tries to read it (EISDIR).
  const id = createJob(db, { eingangAm: '2026-08-14T10:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: dir });
  const app = buildTestApp(db, config);

  const res = await request(app).get(buildSignedDownloadUrl(config, id, 900));

  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'Link ungültig oder abgelaufen.' });
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
