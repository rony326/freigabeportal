import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { openDatabase } from '../../../src/db/index.js';
import { upsertPerson } from '../../../src/db/personenRepo.js';
import { createKonto } from '../../../src/db/kontenRepo.js';
import { createDebitor, getDebitorById } from '../../../src/db/debitorenRepo.js';
import { createZuweisungsregel, getZuweisungsregelById } from '../../../src/db/zuweisungsregelnRepo.js';
import { loadCurrentPerson, requireRole } from '../../../src/middleware/roles.js';
import { createDebitorenRouter } from '../../../src/routes/admin/debitoren.js';

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
  app.use('/admin/debitoren', requireRole(config, 'portal-admin'), createDebitorenRouter({ db }));
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

test('every /admin/debitoren route returns 401 without a session', async () => {
  const db = openDatabase(':memory:');
  const app = buildTestApp(db);
  for (const res of [
    await request(app).get('/admin/debitoren'),
    await request(app).post('/admin/debitoren'),
    await request(app).get('/admin/debitoren/1/bearbeiten'),
    await request(app).post('/admin/debitoren/1'),
    await request(app).post('/admin/debitoren/1/deaktivieren'),
    await request(app).post('/admin/debitoren/1/aktivieren'),
    await request(app).post('/admin/debitoren/regeln'),
    await request(app).get('/admin/debitoren/regeln/1/bearbeiten'),
    await request(app).post('/admin/debitoren/regeln/1'),
    await request(app).post('/admin/debitoren/regeln/1/loeschen'),
  ]) {
    assert.equal(res.status, 401);
  }
  db.close();
});

test('every /admin/debitoren route returns 403 for a non-admin (buchhaltung only)', async () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '77', vorname: 'Nur', nachname: 'Buchhaltung', email: 'b@example.org', gruppen: ['10'], loggedInNow: true });
  const app = buildTestApp(db);
  const res = await request(app).get('/admin/debitoren').set('x-test-person-id', '77');
  assert.equal(res.status, 403);
  db.close();
});

test('POST /admin/debitoren creates a Debitor with an optional Standard-Konto', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  const kontoId = seedKonto(db);
  const app = buildTestApp(db);

  const res = await request(app)
    .post('/admin/debitoren')
    .set('x-test-person-id', '99')
    .type('form')
    .send({ name: 'Muster AG', kontoId: String(kontoId) });

  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/admin/debitoren?gespeichert=1');
  db.close();
});

test('POST /admin/debitoren without a name is rejected', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  const app = buildTestApp(db);
  const res = await request(app).post('/admin/debitoren').set('x-test-person-id', '99').type('form').send({ name: '' });
  assert.equal(res.status, 400);
  assert.match(res.text, /Name ist ein Pflichtfeld/);
  db.close();
});

test('GET /admin/debitoren lists Debitoren with their Standard-Konto resolved', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  const kontoId = seedKonto(db);
  createDebitor(db, { name: 'Muster AG', kontoId });
  const app = buildTestApp(db);

  const res = await request(app).get('/admin/debitoren').set('x-test-person-id', '99');
  assert.equal(res.status, 200);
  assert.match(res.text, /Muster AG/);
  assert.match(res.text, /3000 — Unterhalt/);
  db.close();
});

test('POST /admin/debitoren/:id updates a Debitor, POST .../deaktivieren deactivates it', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  const debitorId = createDebitor(db, { name: 'Alt AG', kontoId: null });
  const app = buildTestApp(db);

  const updateRes = await request(app)
    .post(`/admin/debitoren/${debitorId}`)
    .set('x-test-person-id', '99')
    .type('form')
    .send({ name: 'Neu AG', kontoId: '' });
  assert.equal(updateRes.status, 302);
  assert.equal(getDebitorById(db, debitorId).name, 'Neu AG');

  const deactivateRes = await request(app).post(`/admin/debitoren/${debitorId}/deaktivieren`).set('x-test-person-id', '99');
  assert.equal(deactivateRes.status, 302);
  assert.equal(getDebitorById(db, debitorId).aktiv, 0);

  const listAfterDeactivate = await request(app).get('/admin/debitoren').set('x-test-person-id', '99');
  assert.match(listAfterDeactivate.text, new RegExp(`/admin/debitoren/${debitorId}/aktivieren`), 'a Reaktivieren form should be rendered for the inactive Debitor');
  assert.doesNotMatch(listAfterDeactivate.text, new RegExp(`/admin/debitoren/${debitorId}/deaktivieren`), 'no Deaktivieren form should be rendered for the inactive Debitor');

  const reactivateRes = await request(app).post(`/admin/debitoren/${debitorId}/aktivieren`).set('x-test-person-id', '99');
  assert.equal(reactivateRes.status, 302);
  assert.equal(getDebitorById(db, debitorId).aktiv, 1);
  db.close();
});

test('POST /admin/debitoren/regeln creates a Zuweisungsregel mapping an Absender to a Debitor', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  const debitorId = createDebitor(db, { name: 'Muster AG', kontoId: null });
  const app = buildTestApp(db);

  const res = await request(app)
    .post('/admin/debitoren/regeln')
    .set('x-test-person-id', '99')
    .type('form')
    .send({ absenderMuster: 'lieferant.ch', debitorId: String(debitorId) });

  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/admin/debitoren?gespeichert=1');
  db.close();
});

test('POST /admin/debitoren/regeln rejects a duplicate Absender-Muster', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  const debitorId = createDebitor(db, { name: 'Muster AG', kontoId: null });
  createZuweisungsregel(db, { absenderMuster: 'lieferant.ch', debitorId });
  const app = buildTestApp(db);

  const res = await request(app)
    .post('/admin/debitoren/regeln')
    .set('x-test-person-id', '99')
    .type('form')
    .send({ absenderMuster: 'lieferant.ch', debitorId: String(debitorId) });

  assert.equal(res.status, 400);
  assert.match(res.text, /bereits einem Debitor zugewiesen/);
  db.close();
});

test('GET /admin/debitoren lists Zuweisungsregeln with the Debitor name resolved', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  const debitorId = createDebitor(db, { name: 'Muster AG', kontoId: null });
  createZuweisungsregel(db, { absenderMuster: 'lieferant.ch', debitorId });
  const app = buildTestApp(db);

  const res = await request(app).get('/admin/debitoren').set('x-test-person-id', '99');
  assert.equal(res.status, 200);
  assert.match(res.text, /lieferant\.ch/);
  assert.match(res.text, /Muster AG/);
  db.close();
});

test('POST /admin/debitoren/regeln/:id updates a rule, POST .../loeschen removes it', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  const debitorId = createDebitor(db, { name: 'Muster AG', kontoId: null });
  const regelId = createZuweisungsregel(db, { absenderMuster: 'alt.ch', debitorId });
  const app = buildTestApp(db);

  const updateRes = await request(app)
    .post(`/admin/debitoren/regeln/${regelId}`)
    .set('x-test-person-id', '99')
    .type('form')
    .send({ absenderMuster: 'neu.ch', debitorId: String(debitorId) });
  assert.equal(updateRes.status, 302);
  assert.equal(getZuweisungsregelById(db, regelId).absender_muster, 'neu.ch');

  const deleteRes = await request(app).post(`/admin/debitoren/regeln/${regelId}/loeschen`).set('x-test-person-id', '99');
  assert.equal(deleteRes.status, 302);
  assert.equal(getZuweisungsregelById(db, regelId), null);
  db.close();
});

test('every /admin/debitoren/ibans route returns 401 without a session', async () => {
  const db = openDatabase(':memory:');
  const app = buildTestApp(db);
  for (const res of [
    await request(app).post('/admin/debitoren/ibans'),
    await request(app).post('/admin/debitoren/ibans/1/loeschen'),
  ]) {
    assert.equal(res.status, 401);
  }
  db.close();
});

test('POST /admin/debitoren/ibans creates a mapping with quelle manuell, listed on the Debitoren page', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  const kontoId = seedKonto(db);
  const debitorId = createDebitor(db, { name: 'Muster AG', kontoId });
  const app = buildTestApp(db);

  const res = await request(app)
    .post('/admin/debitoren/ibans')
    .set('x-test-person-id', '99')
    .type('form')
    .send({ iban: 'CH44 3199 9123 0008 8901 2', debitorId: String(debitorId) });

  assert.equal(res.status, 302);
  const { listDebitorIbansAll } = await import('../../../src/db/debitorIbanRepo.js');
  const rows = listDebitorIbansAll(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].iban, 'CH4431999123000889012');
  assert.equal(rows[0].quelle, 'manuell');

  const listRes = await request(app).get('/admin/debitoren').set('x-test-person-id', '99');
  assert.match(listRes.text, /CH4431999123000889012/);
  db.close();
});

test('POST /admin/debitoren/ibans rejects an invalid IBAN', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  const kontoId = seedKonto(db);
  const debitorId = createDebitor(db, { name: 'Muster AG', kontoId });
  const app = buildTestApp(db);

  const res = await request(app)
    .post('/admin/debitoren/ibans')
    .set('x-test-person-id', '99')
    .type('form')
    .send({ iban: 'NICHT-EINE-IBAN', debitorId: String(debitorId) });

  assert.equal(res.status, 400);
  assert.match(res.text, /gültige Schweizer IBAN/);
  db.close();
});

test('POST /admin/debitoren/ibans rejects an IBAN already mapped to another Lieferant', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  const kontoId = seedKonto(db);
  const debitorA = createDebitor(db, { name: 'A AG', kontoId });
  const debitorB = createDebitor(db, { name: 'B AG', kontoId });
  const { createDebitorIban } = await import('../../../src/db/debitorIbanRepo.js');
  createDebitorIban(db, { debitorId: debitorA, iban: 'CH4431999123000889012' });
  const app = buildTestApp(db);

  const res = await request(app)
    .post('/admin/debitoren/ibans')
    .set('x-test-person-id', '99')
    .type('form')
    .send({ iban: 'CH4431999123000889012', debitorId: String(debitorB) });

  assert.equal(res.status, 400);
  assert.match(res.text, /bereits einem Lieferanten zugeordnet/);
  db.close();
});

test('POST /admin/debitoren/ibans/:id/loeschen removes the mapping', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  const kontoId = seedKonto(db);
  const debitorId = createDebitor(db, { name: 'Muster AG', kontoId });
  const { createDebitorIban, getDebitorIbanById } = await import('../../../src/db/debitorIbanRepo.js');
  const ibanId = createDebitorIban(db, { debitorId, iban: 'CH4431999123000889012' });
  const app = buildTestApp(db);

  const res = await request(app).post(`/admin/debitoren/ibans/${ibanId}/loeschen`).set('x-test-person-id', '99');
  assert.equal(res.status, 302);
  assert.equal(getDebitorIbanById(db, ibanId), null);
  db.close();
});
