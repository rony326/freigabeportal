import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { openDatabase } from '../../../src/db/index.js';
import { seedDefaults, getConfigValue, setConfigValue } from '../../../src/db/adminConfigRepo.js';
import { upsertPerson } from '../../../src/db/personenRepo.js';
import { loadCurrentPerson, requireRole } from '../../../src/middleware/roles.js';
import { createEskalationRouter } from '../../../src/routes/admin/eskalation.js';

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
  app.use('/admin/eskalation', requireRole(config, 'superadmin'), createEskalationRouter({ db }));
  return app;
}

function seedAdmin(db) {
  upsertPerson(db, { id: '99', vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'], loggedInNow: true });
}

const ESKALATION_ROUTES = [
  { method: 'get', path: '/admin/eskalation' },
  { method: 'post', path: '/admin/eskalation' },
];

const VALID_BODY = { reminderStunden: '1', eskalationStunden: '2', reminderEmpfaenger: 'gruppe:buchhaltung', eskalationEmpfaenger: 'x@example.org', ibanAbweichungEmpfaenger: 'gruppe:admin' };

test('every Eskalation route returns 401 without any session, and config is untouched', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  const app = buildTestApp(db);
  for (const { method, path } of ESKALATION_ROUTES) {
    const res = await request(app)[method](path).type('form').send(VALID_BODY);
    assert.equal(res.status, 401, `${method.toUpperCase()} ${path} should be 401 without a session`);
  }
  assert.equal(getConfigValue(db, 'reminder_stunden'), '24');
  db.close();
});

test('every Eskalation route returns 403 for a logged-in non-admin (buchhaltung only)', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  upsertPerson(db, { id: '77', vorname: 'Nur', nachname: 'Buchhaltung', email: 'b@example.org', gruppen: ['10'], loggedInNow: true });
  const app = buildTestApp(db);
  for (const { method, path } of ESKALATION_ROUTES) {
    const res = await request(app)[method](path).set('x-test-person-id', '77').type('form').send(VALID_BODY);
    assert.equal(res.status, 403, `${method.toUpperCase()} ${path} should be 403 for a non-admin`);
  }
  db.close();
});

test('GET /admin/eskalation shows the seeded defaults pre-filled', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  const app = buildTestApp(db);
  const res = await request(app).get('/admin/eskalation').set('x-test-person-id', '99');
  assert.equal(res.status, 200);
  assert.match(res.text, /value="24"/);
  assert.match(res.text, /value="48"/);
  assert.match(res.text, /gruppe:buchhaltung/);
  db.close();
});

test('POST /admin/eskalation with valid values persists them', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  const app = buildTestApp(db);
  const res = await request(app)
    .post('/admin/eskalation')
    .set('x-test-person-id', '99')
    .type('form')
    .send({ reminderStunden: '12', eskalationStunden: '36', reminderEmpfaenger: 'gruppe:buchhaltung', eskalationEmpfaenger: 'kirchenpflege@musterkirche.ch\ngruppe:buchhaltung', ibanAbweichungEmpfaenger: 'gruppe:admin' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/admin/eskalation?gespeichert=1');
  assert.equal(getConfigValue(db, 'reminder_stunden'), '12');
  assert.equal(getConfigValue(db, 'eskalation_stunden'), '36');
  assert.equal(getConfigValue(db, 'reminder_empfaenger'), 'gruppe:buchhaltung');
  assert.equal(getConfigValue(db, 'eskalation_empfaenger'), 'kirchenpflege@musterkirche.ch\ngruppe:buchhaltung');
  db.close();
});

test('GET /admin/eskalation?gespeichert=1 shows the save confirmation; without it, it does not', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  const app = buildTestApp(db);
  const withMarker = await request(app).get('/admin/eskalation?gespeichert=1').set('x-test-person-id', '99');
  assert.match(withMarker.text, /Gespeichert\./);
  const withoutMarker = await request(app).get('/admin/eskalation').set('x-test-person-id', '99');
  assert.doesNotMatch(withoutMarker.text, /Gespeichert\./);
  db.close();
});

test('POST /admin/eskalation with invalid Stunden values is rejected, existing config untouched', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  const app = buildTestApp(db);
  const res = await request(app)
    .post('/admin/eskalation')
    .set('x-test-person-id', '99')
    .type('form')
    .send({ ...VALID_BODY, reminderStunden: '-5' });
  assert.equal(res.status, 400);
  assert.equal(getConfigValue(db, 'reminder_stunden'), '24');
  db.close();
});

test('POST /admin/eskalation with an empty Empfänger list is rejected', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  const app = buildTestApp(db);
  const res = await request(app)
    .post('/admin/eskalation')
    .set('x-test-person-id', '99')
    .type('form')
    .send({ ...VALID_BODY, reminderEmpfaenger: '' });
  assert.equal(res.status, 400);
  assert.match(res.text, /Reminder-Empfänger/);
  db.close();
});

test('POST /admin/eskalation with an invalid Empfänger line (neither email nor gruppe:buchhaltung) is rejected', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  const app = buildTestApp(db);
  const res = await request(app)
    .post('/admin/eskalation')
    .set('x-test-person-id', '99')
    .type('form')
    .send({ ...VALID_BODY, eskalationEmpfaenger: 'nicht-valide' });
  assert.equal(res.status, 400);
  assert.match(res.text, /nicht-valide/);
  db.close();
});

test('GET /admin/eskalation shows the current IBAN-Abweichungs-Empfänger value', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  setConfigValue(db, 'iban_abweichung_empfaenger', 'gruppe:admin');
  const app = buildTestApp(db);

  const res = await request(app).get('/admin/eskalation').set('x-test-person-id', '99');
  assert.equal(res.status, 200);
  assert.match(res.text, /gruppe:admin/);
  db.close();
});

test('POST /admin/eskalation saves a valid IBAN-Abweichungs-Empfänger value', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  const app = buildTestApp(db);

  const res = await request(app)
    .post('/admin/eskalation')
    .set('x-test-person-id', '99')
    .type('form')
    .send({ reminderStunden: '24', eskalationStunden: '48', reminderEmpfaenger: 'gruppe:buchhaltung', eskalationEmpfaenger: 'gruppe:buchhaltung', ibanAbweichungEmpfaenger: 'admin@example.org' });

  assert.equal(res.status, 302);
  assert.equal(getConfigValue(db, 'iban_abweichung_empfaenger'), 'admin@example.org');
  db.close();
});

test('POST /admin/eskalation rejects an invalid IBAN-Abweichungs-Empfänger value', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  const app = buildTestApp(db);

  const res = await request(app)
    .post('/admin/eskalation')
    .set('x-test-person-id', '99')
    .type('form')
    .send({ reminderStunden: '24', eskalationStunden: '48', reminderEmpfaenger: 'gruppe:buchhaltung', eskalationEmpfaenger: 'gruppe:buchhaltung', ibanAbweichungEmpfaenger: 'nicht-valide' });

  assert.equal(res.status, 400);
  assert.match(res.text, /IBAN-Abweichungs-Empfänger/);
  db.close();
});
