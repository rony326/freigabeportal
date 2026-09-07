import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson, getPersonById } from '../../src/db/personenRepo.js';
import { createKonto } from '../../src/db/kontenRepo.js';
import { loadCurrentPerson, requireLogin } from '../../src/middleware/roles.js';
import { createFerienmodusRouter } from '../../src/routes/ferienmodus.js';

function buildTestApp(db) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', new URL('../../views', import.meta.url).pathname);
  app.use((req, res, next) => {
    res.locals.branding = { primaryColor: '#000', secondaryColor: '#fff', hasLogo: false, themeAttr: null };
    next();
  });
  app.use(express.urlencoded({ extended: false }));
  app.use((req, res, next) => {
    req.session = { personId: req.headers['x-test-person-id'] };
    next();
  });
  app.use(loadCurrentPerson(db));
  app.use('/ferienmodus', requireLogin(), createFerienmodusRouter({ db }));
  return app;
}

function seedKontoAndPersonen(db) {
  for (const id of ['1', '2', '3', '4', '5']) {
    upsertPerson(db, { id, vorname: `Person${id}`, nachname: 'Muster', email: `p${id}@example.org`, gruppen: ['10'], loggedInNow: true });
  }
  // Person 5 shares no Konto role with person 1 — not a valid Stellvertreter candidate for them.
  return createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
}

test('GET /ferienmodus shows no active period by default', async () => {
  const db = openDatabase(':memory:');
  seedKontoAndPersonen(db);
  const app = buildTestApp(db);

  const res = await request(app).get('/ferienmodus').set('x-test-person-id', '1');
  assert.equal(res.status, 200);
  assert.match(res.text, /kein Ferienmodus/i);
  db.close();
});

test('POST /ferienmodus sets the period and stellvertreter, then GET reflects it', async () => {
  const db = openDatabase(':memory:');
  seedKontoAndPersonen(db);
  const app = buildTestApp(db);

  const postRes = await request(app)
    .post('/ferienmodus')
    .set('x-test-person-id', '1')
    .type('form')
    .send({ von: '2026-09-10', bis: '2026-09-24', stellvertreterId: '2' });
  assert.equal(postRes.status, 302);

  const person = getPersonById(db, '1');
  assert.equal(person.ferienmodus_von, '2026-09-10');
  assert.equal(person.ferienmodus_stellvertreter_id, '2');

  const getRes = await request(app).get('/ferienmodus').set('x-test-person-id', '1');
  assert.match(getRes.text, /2026-09-10/);
  assert.match(getRes.text, /Person2 Muster/);
  db.close();
});

test('POST /ferienmodus with aktion=beenden clears the period', async () => {
  const db = openDatabase(':memory:');
  seedKontoAndPersonen(db);
  const app = buildTestApp(db);
  await request(app).post('/ferienmodus').set('x-test-person-id', '1').type('form').send({ von: '2026-09-10', bis: '2026-09-24', stellvertreterId: '2' });

  const res = await request(app).post('/ferienmodus').set('x-test-person-id', '1').type('form').send({ aktion: 'beenden' });
  assert.equal(res.status, 302);
  const person = getPersonById(db, '1');
  assert.equal(person.ferienmodus_von, null);
  db.close();
});

test('POST /ferienmodus rejects a stellvertreter outside the candidate list', async () => {
  const db = openDatabase(':memory:');
  seedKontoAndPersonen(db);
  const app = buildTestApp(db);

  const res = await request(app)
    .post('/ferienmodus')
    .set('x-test-person-id', '1')
    .type('form')
    .send({ von: '2026-09-10', bis: '2026-09-24', stellvertreterId: '5' });
  assert.equal(res.status, 400);
  assert.match(res.text, /gültigen Stellvertreter/);
  const person = getPersonById(db, '1');
  assert.equal(person.ferienmodus_von, null);
  db.close();
});

test('POST /ferienmodus rejects bis before von', async () => {
  const db = openDatabase(':memory:');
  seedKontoAndPersonen(db);
  const app = buildTestApp(db);

  const res = await request(app)
    .post('/ferienmodus')
    .set('x-test-person-id', '1')
    .type('form')
    .send({ von: '2026-09-24', bis: '2026-09-10', stellvertreterId: '2' });
  assert.equal(res.status, 400);
  assert.match(res.text, /Bis-Datum/);
  db.close();
});
