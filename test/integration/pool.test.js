import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createJob } from '../../src/db/jobsRepo.js';
import { loadCurrentPerson, requireRole } from '../../src/middleware/roles.js';
import { createPoolRouter } from '../../src/routes/pool.js';

function buildTestApp(db) {
  const app = express();
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
