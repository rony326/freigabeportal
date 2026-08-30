import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/db/index.js';
import { createJob, setKontierung, setThumbnailPfad, markGruppeExportiert } from '../../src/db/jobsRepo.js';
import { createKonto } from '../../src/db/kontenRepo.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { loadCurrentPerson } from '../../src/middleware/roles.js';
import { buildSignedDownloadUrl, verifySignedDownload } from '../../src/services/downloadUrl.js';
import { createDownloadsRouter } from '../../src/routes/downloads.js';

const PDF_BYTES = Buffer.from('%PDF-1.4\n%test-fixture\n');

function buildTestApp(db, config) {
  const app = express();
  app.use('/downloads', createDownloadsRouter({ db, config }));
  return app;
}

function buildTestAppWithSession(db, config) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', new URL('../../views', import.meta.url).pathname);
  app.use((req, res, next) => {
    res.locals.branding = { primaryColor: '#000', secondaryColor: '#fff', hasLogo: false, themeAttr: null, seitenTitel: 'Freigabeportal' };
    next();
  });
  app.use((req, res, next) => {
    req.session = { personId: req.headers['x-test-person-id'] };
    next();
  });
  app.use(loadCurrentPerson(db));
  app.use('/downloads', createDownloadsRouter({ db, config }));
  return app;
}

function testConfig() {
  return {
    downloadSigningSecret: 'test-secret',
    churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20' },
  };
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

test('GET /downloads/:jobId/refresh-url returns 401 without a session', async () => {
  const db = openDatabase(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'downloads-test-'));
  const config = testConfig();
  const { id } = seedJobWithFile(db, dir);
  const app = buildTestAppWithSession(db, config);

  const res = await request(app).get(`/downloads/${id}/refresh-url`);
  assert.equal(res.status, 401);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('GET /downloads/:jobId/refresh-url mints a fresh, valid signature for the person the job is assigned to (Kontierung)', async () => {
  const db = openDatabase(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'downloads-test-'));
  const config = testConfig();
  upsertPerson(db, { id: '1', vorname: 'Kon', nachname: 'Tierer', email: 'k@example.org', gruppen: [], loggedInNow: true });
  const { id, pdfPfad } = seedJobWithFile(db, dir);
  db.prepare("UPDATE jobs SET status = 'zugewiesen', zugewiesen_an = '1' WHERE id = ?").run(id);
  const app = buildTestAppWithSession(db, config);

  const res = await request(app).get(`/downloads/${id}/refresh-url`).set('x-test-person-id', '1');
  assert.equal(res.status, 200);
  assert.ok(res.body.url.startsWith(`/downloads/${id}?`));
  const url = new URL(res.body.url, 'http://localhost');
  assert.ok(verifySignedDownload(config, id, url.searchParams.get('expires'), url.searchParams.get('signature')));

  const previewRes = await request(app).get(res.body.url);
  assert.equal(previewRes.status, 200);
  assert.ok(Buffer.from(previewRes.body).equals(PDF_BYTES));
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('GET /downloads/:jobId/refresh-url returns 403 for a person the job is not assigned to', async () => {
  const db = openDatabase(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'downloads-test-'));
  const config = testConfig();
  upsertPerson(db, { id: '1', vorname: 'Kon', nachname: 'Tierer', email: 'k@example.org', gruppen: [], loggedInNow: true });
  upsertPerson(db, { id: '2', vorname: 'Ander', nachname: 'Person', email: 'a@example.org', gruppen: [], loggedInNow: true });
  const { id } = seedJobWithFile(db, dir);
  db.prepare("UPDATE jobs SET status = 'zugewiesen', zugewiesen_an = '1' WHERE id = ?").run(id);
  const app = buildTestAppWithSession(db, config);

  const res = await request(app).get(`/downloads/${id}/refresh-url`).set('x-test-person-id', '2');
  assert.equal(res.status, 403);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('GET /downloads/:jobId/refresh-url allows a portal-admin regardless of job assignment', async () => {
  const db = openDatabase(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'downloads-test-'));
  const config = testConfig();
  upsertPerson(db, { id: '1', vorname: 'Kon', nachname: 'Tierer', email: 'k@example.org', gruppen: [], loggedInNow: true });
  upsertPerson(db, { id: '99', vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'], loggedInNow: true });
  const { id } = seedJobWithFile(db, dir);
  db.prepare("UPDATE jobs SET status = 'zugewiesen', zugewiesen_an = '1' WHERE id = ?").run(id);
  const app = buildTestAppWithSession(db, config);

  const res = await request(app).get(`/downloads/${id}/refresh-url`).set('x-test-person-id', '99');
  assert.equal(res.status, 200);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('GET /downloads/:jobId/refresh-url allows buchhaltung for an unzugewiesen Pool job, but not an unrelated logged-in person', async () => {
  const db = openDatabase(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'downloads-test-'));
  const config = testConfig();
  upsertPerson(db, { id: '10', vorname: 'Buch', nachname: 'Halter', email: 'b@example.org', gruppen: ['10'], loggedInNow: true });
  upsertPerson(db, { id: '11', vorname: 'Irrelevant', nachname: 'Person', email: 'i@example.org', gruppen: [], loggedInNow: true });
  const { id } = seedJobWithFile(db, dir);
  const app = buildTestAppWithSession(db, config);

  const buchhaltungRes = await request(app).get(`/downloads/${id}/refresh-url`).set('x-test-person-id', '10');
  assert.equal(buchhaltungRes.status, 200);

  const irrelevantRes = await request(app).get(`/downloads/${id}/refresh-url`).set('x-test-person-id', '11');
  assert.equal(irrelevantRes.status, 403);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('GET /downloads/:jobId/refresh-url allows the effective Freigeber2 (Stellvertreter2) for a freigabe2 job', async () => {
  const db = openDatabase(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'downloads-test-'));
  const config = testConfig();
  for (const id of ['1', '2', '3', '4']) {
    upsertPerson(db, { id, vorname: `Person${id}`, nachname: 'Muster', email: `p${id}@example.org`, gruppen: [], loggedInNow: false });
  }
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  const { id } = seedJobWithFile(db, dir);
  setKontierung(db, id, kontoId);
  db.prepare("UPDATE jobs SET status = 'freigabe2' WHERE id = ?").run(id);
  const app = buildTestAppWithSession(db, config);

  const res = await request(app).get(`/downloads/${id}/refresh-url`).set('x-test-person-id', '3');
  assert.equal(res.status, 200);

  const unrelatedRes = await request(app).get(`/downloads/${id}/refresh-url`).set('x-test-person-id', '2');
  assert.equal(unrelatedRes.status, 403);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('GET /downloads/:jobId/refresh-url returns 404 for an unknown job id', async () => {
  const db = openDatabase(':memory:');
  const config = testConfig();
  upsertPerson(db, { id: '99', vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'], loggedInNow: true });
  const app = buildTestAppWithSession(db, config);

  const res = await request(app).get('/downloads/999999/refresh-url').set('x-test-person-id', '99');
  assert.equal(res.status, 404);
  db.close();
});

test('GET /downloads/:jobId/thumbnail returns 401 without a session', async () => {
  const db = openDatabase(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'downloads-test-'));
  const config = testConfig();
  const { id } = seedJobWithFile(db, dir);
  const app = buildTestAppWithSession(db, config);

  const res = await request(app).get(`/downloads/${id}/thumbnail`);
  assert.equal(res.status, 401);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('GET /downloads/:jobId/thumbnail serves the PNG bytes for the person the job is assigned to (Kontierung)', async () => {
  const db = openDatabase(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'downloads-test-'));
  const config = testConfig();
  upsertPerson(db, { id: '1', vorname: 'Kon', nachname: 'Tierer', email: 'k@example.org', gruppen: [], loggedInNow: true });
  const { id } = seedJobWithFile(db, dir);
  const thumbnailPfad = join(dir, 'a.png');
  const pngBytes = Buffer.from('89504e470d0a1a0a', 'hex');
  writeFileSync(thumbnailPfad, pngBytes);
  setThumbnailPfad(db, id, thumbnailPfad);
  db.prepare("UPDATE jobs SET status = 'zugewiesen', zugewiesen_an = '1' WHERE id = ?").run(id);
  const app = buildTestAppWithSession(db, config);

  const res = await request(app).get(`/downloads/${id}/thumbnail`).set('x-test-person-id', '1');
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'image/png');
  assert.equal(Buffer.compare(res.body, pngBytes), 0);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('GET /downloads/:jobId/thumbnail serves the PNG bytes to the effective Freigeber2 for a freigabe2 job (the reported bug: "Meine Freigaben" showed a broken image)', async () => {
  const db = openDatabase(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'downloads-test-'));
  const config = testConfig();
  for (const id of ['1', '2', '3', '4']) {
    upsertPerson(db, { id, vorname: `Person${id}`, nachname: 'Muster', email: `p${id}@example.org`, gruppen: [], loggedInNow: false });
  }
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  const { id } = seedJobWithFile(db, dir);
  const thumbnailPfad = join(dir, 'a.png');
  const pngBytes = Buffer.from('89504e470d0a1a0a', 'hex');
  writeFileSync(thumbnailPfad, pngBytes);
  setThumbnailPfad(db, id, thumbnailPfad);
  setKontierung(db, id, kontoId);
  db.prepare("UPDATE jobs SET status = 'freigabe2' WHERE id = ?").run(id);
  const app = buildTestAppWithSession(db, config);

  const res = await request(app).get(`/downloads/${id}/thumbnail`).set('x-test-person-id', '3');
  assert.equal(res.status, 200);
  assert.equal(Buffer.compare(res.body, pngBytes), 0);

  const unrelatedRes = await request(app).get(`/downloads/${id}/thumbnail`).set('x-test-person-id', '2');
  assert.equal(unrelatedRes.status, 404);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('GET /downloads/:jobId/thumbnail returns 404 when the job has no thumbnail', async () => {
  const db = openDatabase(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'downloads-test-'));
  const config = testConfig();
  upsertPerson(db, { id: '99', vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'], loggedInNow: true });
  const { id } = seedJobWithFile(db, dir);
  const app = buildTestAppWithSession(db, config);

  const res = await request(app).get(`/downloads/${id}/thumbnail`).set('x-test-person-id', '99');
  assert.equal(res.status, 404);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('GET /downloads/:jobId/thumbnail returns 404 for a job assigned to someone else (not IDOR-enumerable)', async () => {
  const db = openDatabase(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'downloads-test-'));
  const config = testConfig();
  upsertPerson(db, { id: '1', vorname: 'Kon', nachname: 'Tierer', email: 'k@example.org', gruppen: [], loggedInNow: true });
  upsertPerson(db, { id: '2', vorname: 'Ander', nachname: 'Person', email: 'a@example.org', gruppen: [], loggedInNow: true });
  const { id } = seedJobWithFile(db, dir);
  const thumbnailPfad = join(dir, 'a.png');
  writeFileSync(thumbnailPfad, Buffer.from('89504e470d0a1a0a', 'hex'));
  setThumbnailPfad(db, id, thumbnailPfad);
  db.prepare("UPDATE jobs SET status = 'zugewiesen', zugewiesen_an = '1' WHERE id = ?").run(id);
  const app = buildTestAppWithSession(db, config);

  const res = await request(app).get(`/downloads/${id}/thumbnail`).set('x-test-person-id', '2');
  assert.equal(res.status, 404, 'a job assigned to a different person must not be visible via thumbnail enumeration');

  const ownRes = await request(app).get(`/downloads/${id}/thumbnail`).set('x-test-person-id', '1');
  assert.equal(ownRes.status, 200, 'the assigned person can still see their own thumbnail');
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('GET /downloads/:jobId/thumbnail returns 404 for a nonexistent job id', async () => {
  const db = openDatabase(':memory:');
  const config = testConfig();
  upsertPerson(db, { id: '99', vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'], loggedInNow: true });
  const app = buildTestAppWithSession(db, config);

  const res = await request(app).get('/downloads/999999/thumbnail').set('x-test-person-id', '99');
  assert.equal(res.status, 404);
  db.close();
});

test('GET /downloads/:jobId/thumbnail: a stream error (thumbnail_pfad pointing at a directory) returns 404 instead of crashing', async () => {
  const db = openDatabase(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'downloads-test-'));
  const config = testConfig();
  upsertPerson(db, { id: '99', vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'], loggedInNow: true });
  const { id } = seedJobWithFile(db, dir);
  // existsSync(dir) is true (it's a directory), so the route passes the existence check
  // and only fails when createReadStream actually tries to read it (EISDIR).
  setThumbnailPfad(db, id, dir);
  const app = buildTestAppWithSession(db, config);

  const res = await request(app).get(`/downloads/${id}/thumbnail`).set('x-test-person-id', '99');
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'Kein Thumbnail vorhanden.' });
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('GET /downloads/:jobId serves the merged Gruppen-PDF (not the Elternjob\'s own original PDF) for a job with gruppe_pdf_pfad set', async () => {
  const db = openDatabase(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'downloads-gruppe-test-'));
  const originalPfad = join(dir, 'original.pdf');
  const gruppenPfad = join(dir, 'gruppe.pdf');
  writeFileSync(originalPfad, '%PDF-original');
  writeFileSync(gruppenPfad, '%PDF-gruppe');

  const parentId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'lieferant', absender: null, dateiname: 'r.pdf', pdfPfad: originalPfad });
  markGruppeExportiert(db, parentId, { pdfPfad: gruppenPfad, zeitstempelGesetztAm: null, zeitstempelDateiHash: null });

  const config = testConfig();
  const app = buildTestApp(db, config);
  const url = buildSignedDownloadUrl(config, parentId, 300);
  const res = await request(app).get(url);

  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'application/pdf');
  const bodyStr = typeof res.body === 'string' ? res.body : res.body.toString();
  assert.equal(bodyStr, '%PDF-gruppe');

  rmSync(dir, { recursive: true, force: true });
  db.close();
});
