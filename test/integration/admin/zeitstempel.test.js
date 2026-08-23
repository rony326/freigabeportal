import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { openDatabase } from '../../../src/db/index.js';
import { seedDefaults, getConfigValue } from '../../../src/db/adminConfigRepo.js';
import { upsertPerson } from '../../../src/db/personenRepo.js';
import { loadCurrentPerson, requireRole } from '../../../src/middleware/roles.js';
import { createZeitstempelAdminRouter } from '../../../src/routes/admin/zeitstempel.js';

function buildTestApp(db) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', new URL('../../../views', import.meta.url).pathname);
  app.use((req, res, next) => {
    res.locals.branding = { primaryColor: '#000', secondaryColor: '#fff', hasLogo: false, themeAttr: null, seitenTitel: 'Freigabeportal' };
    next();
  });
  app.use(express.urlencoded({ extended: false }));
  app.use((req, res, next) => {
    req.session = { personId: req.headers['x-test-person-id'] };
    next();
  });
  const config = { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20' } };
  app.use(loadCurrentPerson(db));
  app.use('/admin/zeitstempel', requireRole(config, 'superadmin'), createZeitstempelAdminRouter({ db }));
  return app;
}

function seedAdmin(db) {
  upsertPerson(db, { id: '99', vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'], loggedInNow: true });
}

const ZEITSTEMPEL_ROUTES = [
  { method: 'get', path: '/admin/zeitstempel' },
  { method: 'post', path: '/admin/zeitstempel' },
];

test('every Zeitstempel route returns 401 without any session, and config is untouched', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  const app = buildTestApp(db);
  for (const { method, path } of ZEITSTEMPEL_ROUTES) {
    const res = await request(app)[method](path).type('form').send({ tsaUrl: 'https://tsa.example.org/tsr' });
    assert.equal(res.status, 401, `${method.toUpperCase()} ${path} should be 401 without a session`);
  }
  assert.equal(getConfigValue(db, 'zeitstempel_tsa_url'), '');
  db.close();
});

test('every Zeitstempel route returns 403 for a logged-in non-admin (buchhaltung only)', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  upsertPerson(db, { id: '77', vorname: 'Nur', nachname: 'Buchhaltung', email: 'b@example.org', gruppen: ['10'], loggedInNow: true });
  const app = buildTestApp(db);
  for (const { method, path } of ZEITSTEMPEL_ROUTES) {
    const res = await request(app)[method](path).set('x-test-person-id', '77').type('form').send({ tsaUrl: 'https://tsa.example.org/tsr' });
    assert.equal(res.status, 403, `${method.toUpperCase()} ${path} should be 403 for a non-admin`);
  }
  db.close();
});

test('GET /admin/zeitstempel shows the configured TSA URL, username and Warnschwelle pre-filled, never the password', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  const { setConfigValue } = await import('../../../src/db/adminConfigRepo.js');
  setConfigValue(db, 'zeitstempel_tsa_url', 'https://freetsa.org/tsr');
  setConfigValue(db, 'zeitstempel_tsa_user', 'meinuser');
  setConfigValue(db, 'zeitstempel_tsa_passwort', 'geheimnis123');
  setConfigValue(db, 'zeitstempel_warnung_ab_stunden', '3');
  seedAdmin(db);
  const app = buildTestApp(db);
  const res = await request(app).get('/admin/zeitstempel').set('x-test-person-id', '99');
  assert.equal(res.status, 200);
  assert.match(res.text, /id="tsaUrl"[^>]*value="https:\/\/freetsa\.org\/tsr"/);
  assert.match(res.text, /id="tsaUser"[^>]*value="meinuser"/);
  assert.match(res.text, /id="warnungAbStunden"[^>]*value="3"/);
  assert.doesNotMatch(res.text, /geheimnis123/, 'the stored password must never be echoed back into the form');
  db.close();
});

test('POST /admin/zeitstempel persists a valid TSA URL, username, password and Warnschwelle', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  const app = buildTestApp(db);
  const res = await request(app)
    .post('/admin/zeitstempel')
    .set('x-test-person-id', '99')
    .type('form')
    .send({ tsaUrl: 'https://freetsa.org/tsr', tsaUser: 'meinuser', tsaPasswort: 'geheimnis123', warnungAbStunden: '4' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/admin/zeitstempel?gespeichert=1');
  assert.equal(getConfigValue(db, 'zeitstempel_tsa_url'), 'https://freetsa.org/tsr');
  assert.equal(getConfigValue(db, 'zeitstempel_tsa_user'), 'meinuser');
  assert.equal(getConfigValue(db, 'zeitstempel_tsa_passwort'), 'geheimnis123');
  assert.equal(getConfigValue(db, 'zeitstempel_warnung_ab_stunden'), '4');
  db.close();
});

test('POST /admin/zeitstempel with an empty TSA URL disables the feature (saved as empty, no error)', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  const { setConfigValue } = await import('../../../src/db/adminConfigRepo.js');
  setConfigValue(db, 'zeitstempel_tsa_url', 'https://freetsa.org/tsr');
  const app = buildTestApp(db);
  const res = await request(app).post('/admin/zeitstempel').set('x-test-person-id', '99').type('form').send({ tsaUrl: '', tsaUser: '', warnungAbStunden: '2' });
  assert.equal(res.status, 302);
  assert.equal(getConfigValue(db, 'zeitstempel_tsa_url'), '');
  db.close();
});

test('POST /admin/zeitstempel rejects a TSA URL without http(s):// scheme, config untouched', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  const app = buildTestApp(db);
  const res = await request(app)
    .post('/admin/zeitstempel')
    .set('x-test-person-id', '99')
    .type('form')
    .send({ tsaUrl: 'ftp://tsa.example.org', tsaUser: '', warnungAbStunden: '2' });
  assert.equal(res.status, 400);
  assert.match(res.text, /muss leer sein.*oder mit http/);
  assert.equal(getConfigValue(db, 'zeitstempel_tsa_url'), '');
  db.close();
});

test('POST /admin/zeitstempel rejects a non-numeric or zero Warnschwelle, config untouched', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  const app = buildTestApp(db);
  const res = await request(app)
    .post('/admin/zeitstempel')
    .set('x-test-person-id', '99')
    .type('form')
    .send({ tsaUrl: 'https://freetsa.org/tsr', tsaUser: '', warnungAbStunden: '0' });
  assert.equal(res.status, 400);
  assert.match(res.text, /Warnschwelle/);
  assert.equal(getConfigValue(db, 'zeitstempel_tsa_url'), '');
  db.close();
});

test('POST /admin/zeitstempel with a blank password clears an already-stored one', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  const { setConfigValue } = await import('../../../src/db/adminConfigRepo.js');
  setConfigValue(db, 'zeitstempel_tsa_passwort', 'altes-passwort');
  const app = buildTestApp(db);
  const res = await request(app)
    .post('/admin/zeitstempel')
    .set('x-test-person-id', '99')
    .type('form')
    .send({ tsaUrl: 'https://freetsa.org/tsr', tsaUser: '', tsaPasswort: '', warnungAbStunden: '2' });
  assert.equal(res.status, 302);
  assert.equal(getConfigValue(db, 'zeitstempel_tsa_passwort'), '');
  db.close();
});
