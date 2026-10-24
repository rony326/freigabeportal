import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { openDatabase } from '../../src/db/index.js';
import { seedDefaults } from '../../src/db/adminConfigRepo.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { loadCurrentPerson, requireLogin } from '../../src/middleware/roles.js';
import { createFehlerMeldenRouter } from '../../src/routes/fehlerMelden.js';

const BASE = 'https://portal.example.org';
const REQ_ID = 'abcdef0123456789abcdef0123456789';

function buildTestApp(db, mailer) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', new URL('../../views', import.meta.url).pathname);
  app.use((req, res, next) => {
    res.locals.branding = { primaryColor: '#000', secondaryColor: '#fff', hasLogo: false, themeAttr: null, seitenTitel: 'Freigabeportal' };
    next();
  });
  app.use(express.urlencoded({ extended: false }));
  app.use((req, res, next) => {
    req.session = { personId: req.headers['x-test-person-id'] };
    next();
  });
  const config = { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20' }, publicBaseUrl: BASE };
  app.use(loadCurrentPerson(db));
  app.use('/fehler-melden', requireLogin(), createFehlerMeldenRouter({ db, config, mailer }));
  return app;
}

function setup() {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  upsertPerson(db, { id: '1', vorname: 'Eva', nachname: 'Muster', email: 'eva@example.org', gruppen: ['10'], loggedInNow: true });
  upsertPerson(db, { id: '2', vorname: 'Max', nachname: 'Fremd', email: 'max@example.org', gruppen: ['10'], loggedInNow: true });
  upsertPerson(db, { id: '9', vorname: 'Ad', nachname: 'Min', email: 'admin@example.org', gruppen: ['20'], loggedInNow: true });
  const sent = [];
  const mailer = { async sendMail(m) { sent.push(m); } };
  return { db, sent, app: buildTestApp(db, mailer) };
}

function fehlerAnlegen(db, requestId, personId) {
  db.prepare("INSERT INTO betrieb_fehler (request_id, zeitpunkt, person_id, methode, pfad, status, meldung) VALUES (?, '2026-10-24T10:00:00.000Z', ?, 'GET', '/x', 500, 'boom')").run(requestId, personId);
}

const meldungen = (db) => db.prepare('SELECT * FROM betrieb_fehlermeldungen ORDER BY id').all();

test('ohne Login: GET und POST liefern 401', async () => {
  const { db, app } = setup();
  assert.equal((await request(app).get('/fehler-melden')).status, 401);
  assert.equal((await request(app).post('/fehler-melden').type('form').send({ beschreibung: 'x' })).status, 401);
  assert.equal(meldungen(db).length, 0);
  db.close();
});

test('GET zeigt das Formular mit vorbelegter Fehler-ID', async () => {
  const { app } = setup();
  const res = await request(app).get('/fehler-melden?fehler=abcdef01').set('x-test-person-id', '1');
  assert.equal(res.status, 200);
  assert.match(res.text, /name="beschreibung"/);
  assert.match(res.text, /name="fehlerId" value="abcdef01"/);
});

test('Meldung mit eigener Fehler-ID verknüpft', async () => {
  const { db, app } = setup();
  fehlerAnlegen(db, REQ_ID, '1');
  const res = await request(app).post('/fehler-melden').set('x-test-person-id', '1')
    .set('Referer', `${BASE}/kontierung/5?x=geheim`).set('User-Agent', 'TestAgent/1')
    .type('form').send({ fehlerId: REQ_ID.slice(0, 8), beschreibung: 'Es ging nicht' });
  assert.equal(res.status, 200);
  assert.match(res.text, /Danke/);
  const [m] = meldungen(db);
  assert.equal(m.request_id, REQ_ID);
  assert.equal(m.person_id, '1');
  assert.equal(m.beschreibung, 'Es ging nicht');
  assert.equal(m.seite, '/kontierung/5');
  assert.equal(m.user_agent, 'TestAgent/1');
  assert.equal(m.status, 'offen');
  db.close();
});

test('Fehler ohne Person (NULL) darf verknüpft werden', async () => {
  const { db, app } = setup();
  fehlerAnlegen(db, REQ_ID, null);
  await request(app).post('/fehler-melden').set('x-test-person-id', '1').type('form').send({ fehlerId: REQ_ID.slice(0, 8) });
  assert.equal(meldungen(db)[0].request_id, REQ_ID);
  db.close();
});

test('fremde oder unbekannte Fehler-ID → gespeichert, nicht verknüpft', async () => {
  const { db, app } = setup();
  fehlerAnlegen(db, REQ_ID, '2');
  await request(app).post('/fehler-melden').set('x-test-person-id', '1').type('form').send({ fehlerId: REQ_ID.slice(0, 8), beschreibung: 'a' });
  await request(app).post('/fehler-melden').set('x-test-person-id', '1').type('form').send({ fehlerId: 'ffffffff', beschreibung: 'b' });
  await request(app).post('/fehler-melden').set('x-test-person-id', '1').type('form').send({ fehlerId: 'abc', beschreibung: 'c' });
  const alle = meldungen(db);
  assert.equal(alle.length, 3);
  assert.deepEqual(alle.map((m) => m.request_id), [null, null, null]);
  db.close();
});

test('mehrdeutiger Präfix → nicht verknüpft', async () => {
  const { db, app } = setup();
  fehlerAnlegen(db, 'abcdef01aaaaaaaaaaaaaaaaaaaaaaaa', '1');
  fehlerAnlegen(db, 'abcdef01bbbbbbbbbbbbbbbbbbbbbbbb', '1');
  await request(app).post('/fehler-melden').set('x-test-person-id', '1').type('form').send({ fehlerId: 'abcdef01' });
  assert.equal(meldungen(db)[0].request_id, null);
  db.close();
});

test('Beschreibung > 2000 → 400, nichts gespeichert', async () => {
  const { db, app } = setup();
  const res = await request(app).post('/fehler-melden').set('x-test-person-id', '1').type('form').send({ beschreibung: 'x'.repeat(2001) });
  assert.equal(res.status, 400);
  assert.equal(meldungen(db).length, 0);
  db.close();
});

test('fremder Referer wird nicht als Seite gespeichert', async () => {
  const { db, app } = setup();
  await request(app).post('/fehler-melden').set('x-test-person-id', '1').set('Referer', 'https://evil.example.com/a').type('form').send({});
  assert.equal(meldungen(db)[0].seite, null);
  db.close();
});

test('Mail an Berechtigte, nicht an andere', async () => {
  const { db, app, sent } = setup();
  fehlerAnlegen(db, REQ_ID, '1');
  const res = await request(app).post('/fehler-melden').set('x-test-person-id', '1').type('form').send({ fehlerId: REQ_ID.slice(0, 8), beschreibung: 'Hilfe' });
  assert.equal(res.status, 200);
  const id = meldungen(db)[0].id;
  assert.deepEqual(sent.map((m) => m.to), ['admin@example.org']);
  assert.match(sent[0].text, new RegExp(`${BASE}/admin/betrieb/meldungen/${id}`));
  assert.match(sent[0].text, /Eva Muster/);
  assert.match(sent[0].text, /Hilfe/);
  db.close();
});
