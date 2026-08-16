import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createJob, getJobById, setThumbnailPfad } from '../../src/db/jobsRepo.js';
import { loadCurrentPerson, requireRole } from '../../src/middleware/roles.js';
import { createPoolRouter } from '../../src/routes/pool.js';

function buildTestApp(db) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', new URL('../../views', import.meta.url).pathname);
  app.use((req, res, next) => {
    res.locals.branding = { primaryColor: '#000', secondaryColor: '#fff', hasLogo: false, themeAttr: null };
    next();
  });
  app.use((req, res, next) => {
    req.session = { personId: req.headers['x-test-person-id'] };
    next();
  });
  const config = { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20' } };
  app.use(loadCurrentPerson(db));
  app.use('/api/pool', requireRole(config, 'buchhaltung'), createPoolRouter({ db }));
  return app;
}

function seedBuchhaltungPerson(db) {
  upsertPerson(db, { id: '50', vorname: 'Buch', nachname: 'Halter', email: 'b@example.org', gruppen: ['10'], loggedInNow: true });
}

const POOL_ROUTES = [
  { method: 'get', path: '/api/pool' },
  { method: 'post', path: '/api/pool/1/beanspruchen' },
  { method: 'get', path: '/api/pool/1/thumbnail' },
];

test('every pool route returns 401 without any session', async () => {
  const db = openDatabase(':memory:');
  const app = buildTestApp(db);
  for (const { method, path } of POOL_ROUTES) {
    const res = await request(app)[method](path);
    assert.equal(res.status, 401, `${method.toUpperCase()} ${path} should be 401 without a session`);
  }
  db.close();
});

test('every pool route returns 403 for a logged-in person without the buchhaltung group', async () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '77', vorname: 'Admin', nachname: 'Only', email: 'a@example.org', gruppen: ['20'], loggedInNow: true });
  const app = buildTestApp(db);
  for (const { method, path } of POOL_ROUTES) {
    const res = await request(app)[method](path).set('x-test-person-id', '77');
    assert.equal(res.status, 403, `${method.toUpperCase()} ${path} should be 403 without the buchhaltung group`);
  }
  db.close();
});

test('GET /api/pool lists only unzugewiesen jobs', async () => {
  const db = openDatabase(':memory:');
  seedBuchhaltungPerson(db);
  const id = createJob(db, { eingangAm: '2026-08-14T10:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  const app = buildTestApp(db);
  const res = await request(app).get('/api/pool').set('x-test-person-id', '50');
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].id, id);
  assert.equal(res.body[0].pdf_pfad, undefined);
  db.close();
});

test('POST /api/pool/:id/beanspruchen claims the job for the requesting person', async () => {
  const db = openDatabase(':memory:');
  seedBuchhaltungPerson(db);
  const id = createJob(db, { eingangAm: '2026-08-14T10:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  const app = buildTestApp(db);
  const res = await request(app).post(`/api/pool/${id}/beanspruchen`).set('x-test-person-id', '50');
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'zugewiesen');
  const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
  assert.equal(row.zugewiesen_an, '50');
  db.close();
});

test('a second beanspruchen attempt on the same job returns 409', async () => {
  const db = openDatabase(':memory:');
  seedBuchhaltungPerson(db);
  upsertPerson(db, { id: '51', vorname: 'Zweite', nachname: 'Person', email: 'z@example.org', gruppen: ['10'], loggedInNow: true });
  const id = createJob(db, { eingangAm: '2026-08-14T10:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  const app = buildTestApp(db);
  const firstRes = await request(app).post(`/api/pool/${id}/beanspruchen`).set('x-test-person-id', '50');
  const secondRes = await request(app).post(`/api/pool/${id}/beanspruchen`).set('x-test-person-id', '51');
  assert.equal(firstRes.status, 200);
  assert.equal(secondRes.status, 409);
  db.close();
});

test('GET /api/pool/:id/thumbnail serves the PNG bytes when a thumbnail exists', async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const db = openDatabase(':memory:');
  seedBuchhaltungPerson(db);
  const dir = mkdtempSync(join(tmpdir(), 'thumb-test-'));
  const thumbnailPfad = join(dir, 'a.png');
  const pngBytes = Buffer.from('89504e470d0a1a0a', 'hex');
  writeFileSync(thumbnailPfad, pngBytes);
  const id = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  setThumbnailPfad(db, id, thumbnailPfad);
  const app = buildTestApp(db);

  const res = await request(app).get(`/api/pool/${id}/thumbnail`).set('x-test-person-id', '50');
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'image/png');
  assert.equal(Buffer.compare(res.body, pngBytes), 0);

  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('GET /api/pool/:id/thumbnail returns 404 when the job has no thumbnail', async () => {
  const db = openDatabase(':memory:');
  seedBuchhaltungPerson(db);
  const id = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  const app = buildTestApp(db);

  const res = await request(app).get(`/api/pool/${id}/thumbnail`).set('x-test-person-id', '50');
  assert.equal(res.status, 404);
  db.close();
});

test('GET /api/pool/:id/thumbnail returns 404 for a job assigned to someone else (not IDOR-enumerable)', async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const db = openDatabase(':memory:');
  seedBuchhaltungPerson(db);
  upsertPerson(db, { id: '51', vorname: 'Andere', nachname: 'Person', email: 'andere@example.org', gruppen: ['10'], loggedInNow: true });
  const dir = mkdtempSync(join(tmpdir(), 'thumb-idor-test-'));
  const thumbnailPfad = join(dir, 'a.png');
  writeFileSync(thumbnailPfad, Buffer.from('89504e470d0a1a0a', 'hex'));
  const id = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  setThumbnailPfad(db, id, thumbnailPfad);
  const app = buildTestApp(db);
  // '51' claims the job, taking it out of the pool and assigning it to themselves.
  await request(app).post(`/api/pool/${id}/beanspruchen`).set('x-test-person-id', '51');

  const res = await request(app).get(`/api/pool/${id}/thumbnail`).set('x-test-person-id', '50');
  assert.equal(res.status, 404, 'a job assigned to a different person must not be visible via thumbnail enumeration');

  const ownRes = await request(app).get(`/api/pool/${id}/thumbnail`).set('x-test-person-id', '51');
  assert.equal(ownRes.status, 200, 'the assigned person can still see their own thumbnail');

  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('GET /api/pool/:id/thumbnail returns 404 for a nonexistent job id', async () => {
  const db = openDatabase(':memory:');
  seedBuchhaltungPerson(db);
  const app = buildTestApp(db);

  const res = await request(app).get('/api/pool/999999/thumbnail').set('x-test-person-id', '50');
  assert.equal(res.status, 404);
  db.close();
});

test('a stream error (thumbnail_pfad pointing at a directory) returns 404 instead of crashing', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const db = openDatabase(':memory:');
  seedBuchhaltungPerson(db);
  const dir = mkdtempSync(join(tmpdir(), 'thumb-error-test-'));
  const id = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  // existsSync(dir) is true (it's a directory), so the route passes the existence check
  // and only fails when createReadStream actually tries to read it (EISDIR).
  setThumbnailPfad(db, id, dir);
  const app = buildTestApp(db);

  const res = await request(app).get(`/api/pool/${id}/thumbnail`).set('x-test-person-id', '50');
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'Kein Thumbnail vorhanden.' });

  db.close();
  rmSync(dir, { recursive: true, force: true });
});
