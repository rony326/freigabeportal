import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { openDatabase } from '../../../src/db/index.js';
import { upsertPerson } from '../../../src/db/personenRepo.js';
import { loadCurrentPerson, requireRole } from '../../../src/middleware/roles.js';
import { createKontenRouter } from '../../../src/routes/admin/konten.js';

function buildTestApp(db) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', new URL('../../../views', import.meta.url).pathname);
  app.use((req, res, next) => {
    res.locals.branding = { primaryColor: '#000', secondaryColor: '#fff', hasLogo: false, themeAttr: null };
    next();
  });
  app.use(express.urlencoded({ extended: false }));
  app.use((req, res, next) => {
    req.session = { personId: req.headers['x-test-person-id'] };
    next();
  });
  const config = { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20' } };
  app.use(loadCurrentPerson(db));
  app.use('/admin/konten', requireRole(config, 'portal-admin'), createKontenRouter({ db }));
  return app;
}

function seedPersonen(db) {
  upsertPerson(db, { id: '99', vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'], loggedInNow: true });
  for (const id of ['1', '2', '3', '4', '5']) {
    upsertPerson(db, { id, vorname: `Person${id}`, nachname: 'Muster', email: `p${id}@example.org`, gruppen: ['10'], loggedInNow: false });
  }
}

const KONTEN_ROUTES = [
  { method: 'get', path: '/admin/konten' },
  { method: 'get', path: '/admin/konten/neu' },
  { method: 'post', path: '/admin/konten' },
  { method: 'get', path: '/admin/konten/1/bearbeiten' },
  { method: 'post', path: '/admin/konten/1' },
  { method: 'post', path: '/admin/konten/1/deaktivieren' },
];

test('every Konten route returns 401 without any session, and no Konto is created', async () => {
  const db = openDatabase(':memory:');
  seedPersonen(db);
  const app = buildTestApp(db);
  for (const { method, path } of KONTEN_ROUTES) {
    const res = await request(app)[method](path).type('form').send({ kontonummer: '3000', bezeichnung: 'X', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
    assert.equal(res.status, 401, `${method.toUpperCase()} ${path} should be 401 without a session`);
  }
  const count = db.prepare('SELECT COUNT(*) AS n FROM konten').get().n;
  assert.equal(count, 0, 'no Konto should have been created by the unauthenticated POST attempts');
  db.close();
});

test('every Konten route returns 403 for a logged-in non-admin (buchhaltung only)', async () => {
  const db = openDatabase(':memory:');
  seedPersonen(db);
  upsertPerson(db, { id: '77', vorname: 'Nur', nachname: 'Buchhaltung', email: 'b@example.org', gruppen: ['10'], loggedInNow: true });
  const app = buildTestApp(db);
  for (const { method, path } of KONTEN_ROUTES) {
    const res = await request(app)[method](path).set('x-test-person-id', '77').type('form').send({ kontonummer: '3000', bezeichnung: 'X', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
    assert.equal(res.status, 403, `${method.toUpperCase()} ${path} should be 403 for a non-admin`);
  }
  db.close();
});

test('GET /admin/konten as portal-admin lists konten', async () => {
  const db = openDatabase(':memory:');
  seedPersonen(db);
  const app = buildTestApp(db);
  const res = await request(app).get('/admin/konten').set('x-test-person-id', '99');
  assert.equal(res.status, 200);
  db.close();
});

test('POST /admin/konten with valid data creates a Konto and redirects', async () => {
  const db = openDatabase(':memory:');
  seedPersonen(db);
  const app = buildTestApp(db);
  const res = await request(app)
    .post('/admin/konten')
    .set('x-test-person-id', '99')
    .type('form')
    .send({ kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  assert.equal(res.status, 302);
  const listRes = await request(app).get('/admin/konten').set('x-test-person-id', '99');
  assert.match(listRes.text, /Unterhalt/);
  db.close();
});

test('POST /admin/konten with two identical roles is rejected with a German error, no row created', async () => {
  const db = openDatabase(':memory:');
  seedPersonen(db);
  const app = buildTestApp(db);
  const res = await request(app)
    .post('/admin/konten')
    .set('x-test-person-id', '99')
    .type('form')
    .send({ kontonummer: '3000', bezeichnung: 'X', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '1' });
  assert.equal(res.status, 400);
  assert.match(res.text, /unterschiedliche Personen/);
  const listRes = await request(app).get('/admin/konten').set('x-test-person-id', '99');
  assert.doesNotMatch(listRes.text, />X</);
  db.close();
});

test('GET /admin/konten/:id/bearbeiten pre-fills the form, POST /admin/konten/:id updates it', async () => {
  const db = openDatabase(':memory:');
  seedPersonen(db);
  const app = buildTestApp(db);
  await request(app)
    .post('/admin/konten')
    .set('x-test-person-id', '99')
    .type('form')
    .send({ kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });

  const listRes = await request(app).get('/admin/konten').set('x-test-person-id', '99');
  const idMatch = listRes.text.match(/\/admin\/konten\/(\d+)\/bearbeiten/);
  assert.ok(idMatch, 'expected an edit link in the list');
  const id = idMatch[1];

  const editRes = await request(app).get(`/admin/konten/${id}/bearbeiten`).set('x-test-person-id', '99');
  assert.equal(editRes.status, 200);
  assert.match(editRes.text, /value="3000"/);

  const updateRes = await request(app)
    .post(`/admin/konten/${id}`)
    .set('x-test-person-id', '99')
    .type('form')
    .send({ kontonummer: '3001', bezeichnung: 'Unterhalt neu', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  assert.equal(updateRes.status, 302);

  const listAfter = await request(app).get('/admin/konten').set('x-test-person-id', '99');
  assert.match(listAfter.text, /3001/);
  db.close();
});

test('POST /admin/konten/:id/deaktivieren removes it from the default list but keeps the row', async () => {
  const db = openDatabase(':memory:');
  seedPersonen(db);
  const app = buildTestApp(db);
  await request(app)
    .post('/admin/konten')
    .set('x-test-person-id', '99')
    .type('form')
    .send({ kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });

  const listRes = await request(app).get('/admin/konten').set('x-test-person-id', '99');
  const idMatch = listRes.text.match(/\/admin\/konten\/(\d+)\/deaktivieren/);
  const id = idMatch[1];

  const deactivateRes = await request(app).post(`/admin/konten/${id}/deaktivieren`).set('x-test-person-id', '99');
  assert.equal(deactivateRes.status, 302);

  const listAfter = await request(app).get('/admin/konten').set('x-test-person-id', '99');
  assert.doesNotMatch(listAfter.text, /Unterhalt/);
  const row = db.prepare('SELECT * FROM konten WHERE id = ?').get(Number(id));
  assert.equal(row.aktiv, 0);
  db.close();
});
