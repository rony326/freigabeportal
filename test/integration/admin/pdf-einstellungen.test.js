import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { openDatabase } from '../../../src/db/index.js';
import { seedDefaults, getConfigValue } from '../../../src/db/adminConfigRepo.js';
import { upsertPerson } from '../../../src/db/personenRepo.js';
import { loadCurrentPerson, requireRole } from '../../../src/middleware/roles.js';
import { createPdfEinstellungenRouter } from '../../../src/routes/admin/pdf-einstellungen.js';

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
  app.use('/admin/pdf-einstellungen', requireRole(config, 'portal-admin'), createPdfEinstellungenRouter({ db }));
  return app;
}

function seedAdmin(db) {
  upsertPerson(db, { id: '99', vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'], loggedInNow: true });
}

const ROUTES = [
  { method: 'get', path: '/admin/pdf-einstellungen' },
  { method: 'post', path: '/admin/pdf-einstellungen' },
];

test('every PDF-Einstellungen route returns 401 without any session, and config is untouched', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  const app = buildTestApp(db);
  for (const { method, path } of ROUTES) {
    const res = await request(app)[method](path).type('form').send({ visumSeitePosition: 'erste' });
    assert.equal(res.status, 401, `${method.toUpperCase()} ${path} should be 401 without a session`);
  }
  assert.equal(getConfigValue(db, 'visum_seite_position'), 'letzte');
  db.close();
});

test('every PDF-Einstellungen route returns 403 for a logged-in non-admin (buchhaltung only)', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  upsertPerson(db, { id: '77', vorname: 'Nur', nachname: 'Buchhaltung', email: 'b@example.org', gruppen: ['10'], loggedInNow: true });
  const app = buildTestApp(db);
  for (const { method, path } of ROUTES) {
    const res = await request(app)[method](path).set('x-test-person-id', '77').type('form').send({ visumSeitePosition: 'erste' });
    assert.equal(res.status, 403, `${method.toUpperCase()} ${path} should be 403 for a non-admin`);
  }
  db.close();
});

test('GET /admin/pdf-einstellungen shows the seeded default pre-selected', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  const app = buildTestApp(db);
  const res = await request(app).get('/admin/pdf-einstellungen').set('x-test-person-id', '99');
  assert.equal(res.status, 200);
  assert.match(res.text, /<option value="letzte" selected>/);
  db.close();
});

test('POST /admin/pdf-einstellungen with "erste" persists it', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  const app = buildTestApp(db);
  const res = await request(app)
    .post('/admin/pdf-einstellungen')
    .set('x-test-person-id', '99')
    .type('form')
    .send({ visumSeitePosition: 'erste' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/admin/pdf-einstellungen?gespeichert=1');
  assert.equal(getConfigValue(db, 'visum_seite_position'), 'erste');
  db.close();
});

test('GET /admin/pdf-einstellungen?gespeichert=1 shows the save confirmation; without it, it does not', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  const app = buildTestApp(db);
  const withMarker = await request(app).get('/admin/pdf-einstellungen?gespeichert=1').set('x-test-person-id', '99');
  assert.match(withMarker.text, /Gespeichert\./);
  const withoutMarker = await request(app).get('/admin/pdf-einstellungen').set('x-test-person-id', '99');
  assert.doesNotMatch(withoutMarker.text, /Gespeichert\./);
  db.close();
});

test('POST /admin/pdf-einstellungen with an invalid value is rejected, existing config untouched', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  const app = buildTestApp(db);
  const res = await request(app)
    .post('/admin/pdf-einstellungen')
    .set('x-test-person-id', '99')
    .type('form')
    .send({ visumSeitePosition: 'irgendwas' });
  assert.equal(res.status, 400);
  assert.equal(getConfigValue(db, 'visum_seite_position'), 'letzte');
  db.close();
});
