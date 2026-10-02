import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { openDatabase } from '../../../src/db/index.js';
import { upsertPerson } from '../../../src/db/personenRepo.js';
import { createKonto } from '../../../src/db/kontenRepo.js';
import { createKreditor, getKreditorById } from '../../../src/db/kreditorenRepo.js';
import { createZuweisungsregel, getZuweisungsregelById } from '../../../src/db/zuweisungsregelnRepo.js';
import { loadCurrentPerson } from '../../../src/middleware/roles.js';
import { loadNavFlags } from '../../../src/middleware/nav.js';
import { requirePermission } from '../../../src/middleware/permissions.js';
import { setBerechtigungenForPerson } from '../../../src/db/personBerechtigungenRepo.js';
import { createKreditorenRouter } from '../../../src/routes/admin/kreditoren.js';

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
  const config = { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20', groupIdManager: '30' } };
  app.use(loadCurrentPerson(db));
  app.use(loadNavFlags(db, config));
  app.use('/admin/kreditoren', requirePermission(db, config, 'kreditoren_verwalten'), createKreditorenRouter({ db }));
  return app;
}

function seedAdmin(db) {
  upsertPerson(db, { id: '99', vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'], loggedInNow: true });
}

function seedKonto(db) {
  for (const id of ['1', '2', '3', '4']) {
    upsertPerson(db, { id, vorname: `Person${id}`, nachname: 'Muster', email: `p${id}@example.org`, gruppen: ['10'], loggedInNow: false });
  }
  return createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
}

test('every /admin/kreditoren route returns 401 without a session', async () => {
  const db = openDatabase(':memory:');
  const app = buildTestApp(db);
  for (const res of [
    await request(app).get('/admin/kreditoren'),
    await request(app).post('/admin/kreditoren'),
    await request(app).get('/admin/kreditoren/1/bearbeiten'),
    await request(app).post('/admin/kreditoren/1'),
    await request(app).post('/admin/kreditoren/1/deaktivieren'),
    await request(app).post('/admin/kreditoren/1/aktivieren'),
    await request(app).post('/admin/kreditoren/regeln'),
    await request(app).get('/admin/kreditoren/regeln/1/bearbeiten'),
    await request(app).post('/admin/kreditoren/regeln/1'),
    await request(app).post('/admin/kreditoren/regeln/1/loeschen'),
  ]) {
    assert.equal(res.status, 401);
  }
  db.close();
});

test('every /admin/kreditoren route returns 403 for a non-admin (buchhaltung only)', async () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '77', vorname: 'Nur', nachname: 'Buchhaltung', email: 'b@example.org', gruppen: ['10'], loggedInNow: true });
  const app = buildTestApp(db);
  const res = await request(app).get('/admin/kreditoren').set('x-test-person-id', '77');
  assert.equal(res.status, 403);
  db.close();
});

test('POST /admin/kreditoren creates a Kreditor with an optional Standard-Konto', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  const kontoId = seedKonto(db);
  const app = buildTestApp(db);

  const res = await request(app)
    .post('/admin/kreditoren')
    .set('x-test-person-id', '99')
    .type('form')
    .send({ name: 'Muster AG', kontoId: String(kontoId) });

  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/admin/kreditoren?gespeichert=1');
  db.close();
});

test('POST /admin/kreditoren without a name is rejected', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  const app = buildTestApp(db);
  const res = await request(app).post('/admin/kreditoren').set('x-test-person-id', '99').type('form').send({ name: '' });
  assert.equal(res.status, 400);
  assert.match(res.text, /Name ist ein Pflichtfeld/);
  db.close();
});

test('GET /admin/kreditoren lists Kreditoren with their Standard-Konto resolved', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  const kontoId = seedKonto(db);
  createKreditor(db, { name: 'Muster AG', kontoId });
  const app = buildTestApp(db);

  const res = await request(app).get('/admin/kreditoren').set('x-test-person-id', '99');
  assert.equal(res.status, 200);
  assert.match(res.text, /Muster AG/);
  assert.match(res.text, /3000 — Unterhalt/);
  db.close();
});

test('POST /admin/kreditoren/:id updates a Kreditor, POST .../deaktivieren deactivates it', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  const kreditorId = createKreditor(db, { name: 'Alt AG', kontoId: null });
  const app = buildTestApp(db);

  const updateRes = await request(app)
    .post(`/admin/kreditoren/${kreditorId}`)
    .set('x-test-person-id', '99')
    .type('form')
    .send({ name: 'Neu AG', kontoId: '' });
  assert.equal(updateRes.status, 302);
  assert.equal(getKreditorById(db, kreditorId).name, 'Neu AG');

  const deactivateRes = await request(app).post(`/admin/kreditoren/${kreditorId}/deaktivieren`).set('x-test-person-id', '99');
  assert.equal(deactivateRes.status, 302);
  assert.equal(getKreditorById(db, kreditorId).aktiv, 0);

  const listAfterDeactivate = await request(app).get('/admin/kreditoren').set('x-test-person-id', '99');
  assert.match(listAfterDeactivate.text, new RegExp(`/admin/kreditoren/${kreditorId}/aktivieren`), 'a Reaktivieren form should be rendered for the inactive Kreditor');
  assert.doesNotMatch(listAfterDeactivate.text, new RegExp(`/admin/kreditoren/${kreditorId}/deaktivieren`), 'no Deaktivieren form should be rendered for the inactive Kreditor');

  const reactivateRes = await request(app).post(`/admin/kreditoren/${kreditorId}/aktivieren`).set('x-test-person-id', '99');
  assert.equal(reactivateRes.status, 302);
  assert.equal(getKreditorById(db, kreditorId).aktiv, 1);
  db.close();
});

test('POST /admin/kreditoren/regeln creates a Zuweisungsregel mapping an Absender to a Kreditor', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  const kreditorId = createKreditor(db, { name: 'Muster AG', kontoId: null });
  const app = buildTestApp(db);

  const res = await request(app)
    .post('/admin/kreditoren/regeln')
    .set('x-test-person-id', '99')
    .type('form')
    .send({ absenderMuster: 'lieferant.ch', kreditorId: String(kreditorId) });

  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/admin/kreditoren?gespeichert=1');
  db.close();
});

test('POST /admin/kreditoren/regeln rejects a duplicate Absender-Muster', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  const kreditorId = createKreditor(db, { name: 'Muster AG', kontoId: null });
  createZuweisungsregel(db, { absenderMuster: 'lieferant.ch', kreditorId });
  const app = buildTestApp(db);

  const res = await request(app)
    .post('/admin/kreditoren/regeln')
    .set('x-test-person-id', '99')
    .type('form')
    .send({ absenderMuster: 'lieferant.ch', kreditorId: String(kreditorId) });

  assert.equal(res.status, 400);
  assert.match(res.text, /bereits einem Kreditor zugewiesen/);
  db.close();
});

test('GET /admin/kreditoren lists Zuweisungsregeln with the Kreditor name resolved', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  const kreditorId = createKreditor(db, { name: 'Muster AG', kontoId: null });
  createZuweisungsregel(db, { absenderMuster: 'lieferant.ch', kreditorId });
  const app = buildTestApp(db);

  const res = await request(app).get('/admin/kreditoren').set('x-test-person-id', '99');
  assert.equal(res.status, 200);
  assert.match(res.text, /lieferant\.ch/);
  assert.match(res.text, /Muster AG/);
  db.close();
});

test('POST /admin/kreditoren/regeln/:id updates a rule, POST .../loeschen removes it', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  const kreditorId = createKreditor(db, { name: 'Muster AG', kontoId: null });
  const regelId = createZuweisungsregel(db, { absenderMuster: 'alt.ch', kreditorId });
  const app = buildTestApp(db);

  const updateRes = await request(app)
    .post(`/admin/kreditoren/regeln/${regelId}`)
    .set('x-test-person-id', '99')
    .type('form')
    .send({ absenderMuster: 'neu.ch', kreditorId: String(kreditorId) });
  assert.equal(updateRes.status, 302);
  assert.equal(getZuweisungsregelById(db, regelId).absender_muster, 'neu.ch');

  const deleteRes = await request(app).post(`/admin/kreditoren/regeln/${regelId}/loeschen`).set('x-test-person-id', '99');
  assert.equal(deleteRes.status, 302);
  assert.equal(getZuweisungsregelById(db, regelId), null);
  db.close();
});

test('every /admin/kreditoren/ibans route returns 401 without a session', async () => {
  const db = openDatabase(':memory:');
  const app = buildTestApp(db);
  for (const res of [
    await request(app).post('/admin/kreditoren/ibans'),
    await request(app).post('/admin/kreditoren/ibans/1/loeschen'),
  ]) {
    assert.equal(res.status, 401);
  }
  db.close();
});

test('POST /admin/kreditoren/ibans creates a mapping with quelle manuell, listed on the Kreditoren page', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  const kontoId = seedKonto(db);
  const kreditorId = createKreditor(db, { name: 'Muster AG', kontoId });
  const app = buildTestApp(db);

  const res = await request(app)
    .post('/admin/kreditoren/ibans')
    .set('x-test-person-id', '99')
    .type('form')
    .send({ iban: 'CH44 3199 9123 0008 8901 2', kreditorId: String(kreditorId) });

  assert.equal(res.status, 302);
  const { listKreditorIbansAll } = await import('../../../src/db/kreditorIbanRepo.js');
  const rows = listKreditorIbansAll(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].iban, 'CH4431999123000889012');
  assert.equal(rows[0].quelle, 'manuell');

  const listRes = await request(app).get('/admin/kreditoren').set('x-test-person-id', '99');
  assert.match(listRes.text, /CH4431999123000889012/);
  db.close();
});

test('POST /admin/kreditoren/ibans rejects an invalid IBAN', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  const kontoId = seedKonto(db);
  const kreditorId = createKreditor(db, { name: 'Muster AG', kontoId });
  const app = buildTestApp(db);

  const res = await request(app)
    .post('/admin/kreditoren/ibans')
    .set('x-test-person-id', '99')
    .type('form')
    .send({ iban: 'NICHT-EINE-IBAN', kreditorId: String(kreditorId) });

  assert.equal(res.status, 400);
  assert.match(res.text, /gültige Schweizer IBAN/);
  db.close();
});

test('POST /admin/kreditoren/ibans rejects an IBAN already mapped to another Lieferant', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  const kontoId = seedKonto(db);
  const kreditorA = createKreditor(db, { name: 'A AG', kontoId });
  const kreditorB = createKreditor(db, { name: 'B AG', kontoId });
  const { createKreditorIban } = await import('../../../src/db/kreditorIbanRepo.js');
  createKreditorIban(db, { kreditorId: kreditorA, iban: 'CH4431999123000889012' });
  const app = buildTestApp(db);

  const res = await request(app)
    .post('/admin/kreditoren/ibans')
    .set('x-test-person-id', '99')
    .type('form')
    .send({ iban: 'CH4431999123000889012', kreditorId: String(kreditorB) });

  assert.equal(res.status, 400);
  assert.match(res.text, /bereits einem Lieferanten zugeordnet/);
  db.close();
});

test('POST /admin/kreditoren/ibans/:id/loeschen removes the mapping', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  const kontoId = seedKonto(db);
  const kreditorId = createKreditor(db, { name: 'Muster AG', kontoId });
  const { createKreditorIban, getKreditorIbanById } = await import('../../../src/db/kreditorIbanRepo.js');
  const ibanId = createKreditorIban(db, { kreditorId, iban: 'CH4431999123000889012' });
  const app = buildTestApp(db);

  const res = await request(app).post(`/admin/kreditoren/ibans/${ibanId}/loeschen`).set('x-test-person-id', '99');
  assert.equal(res.status, 302);
  assert.equal(getKreditorIbanById(db, ibanId), null);
  db.close();
});

test('GET /admin/kreditoren returns 200 for a Manager', async () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '55', vorname: 'Mana', nachname: 'Ger', email: 'manager@example.org', gruppen: ['30'], loggedInNow: true });
  const app = buildTestApp(db);
  const res = await request(app).get('/admin/kreditoren').set('x-test-person-id', '55');
  assert.equal(res.status, 200);
  db.close();
});

test('GET /admin/kreditoren returns 200 for a plain person with exactly this individual grant, and 403 for a different one', async () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'Nur', nachname: 'Konten', email: 'nur@example.org', gruppen: [], loggedInNow: true });
  setBerechtigungenForPerson(db, '1', ['konten_verwalten']);
  const app = buildTestApp(db);
  const res = await request(app).get('/admin/kreditoren').set('x-test-person-id', '1');
  assert.equal(res.status, 403);

  setBerechtigungenForPerson(db, '1', ['kreditoren_verwalten']);
  const res2 = await request(app).get('/admin/kreditoren').set('x-test-person-id', '1');
  assert.equal(res2.status, 200);
  db.close();
});
