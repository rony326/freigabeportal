import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { openDatabase } from '../../../src/db/index.js';
import { upsertPerson } from '../../../src/db/personenRepo.js';
import { createKonto } from '../../../src/db/kontenRepo.js';
import { loadCurrentPerson, requireRole } from '../../../src/middleware/roles.js';
import { createZuweisungsregelnRouter } from '../../../src/routes/admin/zuweisungsregeln.js';

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
  app.use('/admin/zuweisungsregeln', requireRole(config, 'portal-admin'), createZuweisungsregelnRouter({ db }));
  return app;
}

function seedKonto(db) {
  upsertPerson(db, { id: '99', vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'], loggedInNow: true });
  for (const id of ['1', '2', '3', '4']) {
    upsertPerson(db, { id, vorname: `Person${id}`, nachname: 'Muster', email: `p${id}@example.org`, gruppen: ['10'], loggedInNow: false });
  }
  return createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
}

const ZUWEISUNGSREGELN_ROUTES = [
  { method: 'get', path: '/admin/zuweisungsregeln' },
  { method: 'get', path: '/admin/zuweisungsregeln/neu' },
  { method: 'post', path: '/admin/zuweisungsregeln' },
  { method: 'get', path: '/admin/zuweisungsregeln/1/bearbeiten' },
  { method: 'post', path: '/admin/zuweisungsregeln/1' },
  { method: 'post', path: '/admin/zuweisungsregeln/1/loeschen' },
];

test('every Zuweisungsregeln route returns 401 without any session, and no rule is created', async () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const app = buildTestApp(db);
  for (const { method, path } of ZUWEISUNGSREGELN_ROUTES) {
    const res = await request(app)[method](path).type('form').send({ absenderMuster: 'lieferant.ch', kontoId: String(kontoId) });
    assert.equal(res.status, 401, `${method.toUpperCase()} ${path} should be 401 without a session`);
  }
  const count = db.prepare('SELECT COUNT(*) AS n FROM zuweisungsregeln').get().n;
  assert.equal(count, 0, 'no Zuweisungsregel should have been created by the unauthenticated attempts');
  db.close();
});

test('every Zuweisungsregeln route returns 403 for a logged-in non-admin (buchhaltung only)', async () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  upsertPerson(db, { id: '77', vorname: 'Nur', nachname: 'Buchhaltung', email: 'b@example.org', gruppen: ['10'], loggedInNow: true });
  const app = buildTestApp(db);
  for (const { method, path } of ZUWEISUNGSREGELN_ROUTES) {
    const res = await request(app)[method](path).set('x-test-person-id', '77').type('form').send({ absenderMuster: 'lieferant.ch', kontoId: String(kontoId) });
    assert.equal(res.status, 403, `${method.toUpperCase()} ${path} should be 403 for a non-admin`);
  }
  db.close();
});

test('POST /admin/zuweisungsregeln with valid data creates a rule and redirects', async () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const app = buildTestApp(db);
  const res = await request(app)
    .post('/admin/zuweisungsregeln')
    .set('x-test-person-id', '99')
    .type('form')
    .send({ absenderMuster: 'lieferant.ch', kontoId: String(kontoId) });
  assert.equal(res.status, 302);
  const listRes = await request(app).get('/admin/zuweisungsregeln').set('x-test-person-id', '99');
  assert.match(listRes.text, /lieferant\.ch/);
  db.close();
});

test('POST /admin/zuweisungsregeln with a duplicate pattern is rejected with a German error', async () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const app = buildTestApp(db);
  await request(app).post('/admin/zuweisungsregeln').set('x-test-person-id', '99').type('form').send({ absenderMuster: 'lieferant.ch', kontoId: String(kontoId) });
  const res = await request(app).post('/admin/zuweisungsregeln').set('x-test-person-id', '99').type('form').send({ absenderMuster: 'lieferant.ch', kontoId: String(kontoId) });
  assert.equal(res.status, 400);
  assert.match(res.text, /bereits/);
  db.close();
});

test('POST /admin/zuweisungsregeln with an invalid pattern (not a domain or email) is rejected with a German error', async () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const app = buildTestApp(db);
  const res = await request(app)
    .post('/admin/zuweisungsregeln')
    .set('x-test-person-id', '99')
    .type('form')
    .send({ absenderMuster: 'ch', kontoId: String(kontoId) });
  assert.equal(res.status, 400);
  assert.match(res.text, /gültige E-Mail-Adresse oder Domain/);
  db.close();
});

test('edit and delete a Zuweisungsregel', async () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const app = buildTestApp(db);
  await request(app).post('/admin/zuweisungsregeln').set('x-test-person-id', '99').type('form').send({ absenderMuster: 'lieferant.ch', kontoId: String(kontoId) });

  const listRes = await request(app).get('/admin/zuweisungsregeln').set('x-test-person-id', '99');
  const idMatch = listRes.text.match(/\/admin\/zuweisungsregeln\/(\d+)\/bearbeiten/);
  const id = idMatch[1];

  const updateRes = await request(app)
    .post(`/admin/zuweisungsregeln/${id}`)
    .set('x-test-person-id', '99')
    .type('form')
    .send({ absenderMuster: 'rechnungen@lieferant.ch', kontoId: String(kontoId) });
  assert.equal(updateRes.status, 302);

  const afterEdit = await request(app).get('/admin/zuweisungsregeln').set('x-test-person-id', '99');
  assert.match(afterEdit.text, /rechnungen@lieferant\.ch/);

  const deleteRes = await request(app).post(`/admin/zuweisungsregeln/${id}/loeschen`).set('x-test-person-id', '99');
  assert.equal(deleteRes.status, 302);
  const afterDelete = await request(app).get('/admin/zuweisungsregeln').set('x-test-person-id', '99');
  assert.doesNotMatch(afterDelete.text, /rechnungen@lieferant\.ch/);
  db.close();
});
