import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { openDatabase } from '../../../src/db/index.js';
import { seedDefaults, getConfigValue, setConfigValue } from '../../../src/db/adminConfigRepo.js';
import { upsertPerson } from '../../../src/db/personenRepo.js';
import { loadCurrentPerson, requireRole } from '../../../src/middleware/roles.js';
import { loadNavFlags } from '../../../src/middleware/nav.js';
import { createModuleRouter } from '../../../src/routes/admin/module.js';

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
  app.use('/admin/module', requireRole(config, 'superadmin'), createModuleRouter({ db }));
  return app;
}

function seedAdmin(db) {
  upsertPerson(db, { id: '99', vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'], loggedInNow: true });
}

const MODULE_ROUTES = [
  { method: 'get', path: '/admin/module' },
  { method: 'post', path: '/admin/module' },
];

test('every Module route returns 401 without any session, and config is untouched', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  const app = buildTestApp(db);
  for (const { method, path } of MODULE_ROUTES) {
    const res = await request(app)[method](path).type('form').send({ spesenAktiv: '1' });
    assert.equal(res.status, 401, `${method.toUpperCase()} ${path} should be 401 without a session`);
  }
  assert.equal(getConfigValue(db, 'modul_spesen_aktiv'), '1');
  db.close();
});

test('every Module route returns 403 for a logged-in non-admin (Manager)', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  upsertPerson(db, { id: '55', vorname: 'Mana', nachname: 'Ger', email: 'manager@example.org', gruppen: ['30'], loggedInNow: true });
  const app = buildTestApp(db);
  for (const { method, path } of MODULE_ROUTES) {
    const res = await request(app)[method](path).set('x-test-person-id', '55').type('form').send({ spesenAktiv: '1' });
    assert.equal(res.status, 403, `${method.toUpperCase()} ${path} should be 403 for a non-superadmin`);
  }
  db.close();
});

test('GET /admin/module shows the Spesenmodul checkbox checked when the module is enabled', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  const app = buildTestApp(db);
  const res = await request(app).get('/admin/module').set('x-test-person-id', '99');
  assert.equal(res.status, 200);
  assert.match(res.text, /name="spesenAktiv"[^>]*checked/);
  db.close();
});

test('GET /admin/module shows the Spesenmodul checkbox unchecked when disabled', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  setConfigValue(db, 'modul_spesen_aktiv', '0');
  const app = buildTestApp(db);
  const res = await request(app).get('/admin/module').set('x-test-person-id', '99');
  assert.equal(res.status, 200);
  assert.doesNotMatch(res.text, /name="spesenAktiv"[^>]*checked/);
  db.close();
});

test('POST /admin/module with the checkbox unchecked (absent field) disables the module', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  const app = buildTestApp(db);
  const res = await request(app).post('/admin/module').set('x-test-person-id', '99').type('form').send({});
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/admin/module?gespeichert=1');
  assert.equal(getConfigValue(db, 'modul_spesen_aktiv'), '0');
  db.close();
});

test('POST /admin/module with the checkbox checked re-enables the module', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  setConfigValue(db, 'modul_spesen_aktiv', '0');
  const app = buildTestApp(db);
  const res = await request(app).post('/admin/module').set('x-test-person-id', '99').type('form').send({ spesenAktiv: '1' });
  assert.equal(res.status, 302);
  assert.equal(getConfigValue(db, 'modul_spesen_aktiv'), '1');
  db.close();
});
