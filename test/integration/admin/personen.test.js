// test/integration/admin/personen.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { openDatabase } from '../../../src/db/index.js';
import { upsertPerson } from '../../../src/db/personenRepo.js';
import { loadCurrentPerson, requireAnyRole, requireRole } from '../../../src/middleware/roles.js';
import { loadNavFlags } from '../../../src/middleware/nav.js';
import { createPersonenRouter } from '../../../src/routes/admin/personen.js';
import { listBerechtigungenForPerson } from '../../../src/db/personBerechtigungenRepo.js';

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
  app.use('/admin/personen', requireAnyRole(config, ['superadmin', 'manager']), createPersonenRouter({ db, config }));
  return app;
}

test('GET /admin/personen without a logged-in session returns 401', async () => {
  const db = openDatabase(':memory:');
  const app = buildTestApp(db);
  const res = await request(app).get('/admin/personen');
  assert.equal(res.status, 401);
  db.close();
});

test('GET /admin/personen returns 403 for a logged-in non-admin (buchhaltung only)', async () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '77', vorname: 'Nur', nachname: 'Buchhaltung', email: 'b@example.org', gruppen: ['10'], loggedInNow: true });
  const app = buildTestApp(db);
  const res = await request(app).get('/admin/personen').set('x-test-person-id', '77');
  assert.equal(res.status, 403);
  db.close();
});

test('GET /admin/personen returns 200 for a Manager', async () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '55', vorname: 'Mana', nachname: 'Ger', email: 'manager@example.org', gruppen: ['30'], loggedInNow: true });
  const app = buildTestApp(db);
  const res = await request(app).get('/admin/personen').set('x-test-person-id', '55');
  assert.equal(res.status, 200);
  db.close();
});

test('GET /admin/personen lists all persons including inactive ones, and flags unresolved persons', async () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '99', vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'], loggedInNow: true });
  upsertPerson(db, { id: '1', vorname: 'Aktiv', nachname: 'Person', email: 'a@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '2', vorname: 'Inaktiv', nachname: 'Person', email: 'i@example.org', gruppen: ['10'], loggedInNow: false });
  db.prepare('UPDATE personen SET aktiv = 0 WHERE churchtools_person_id = ?').run('2');
  upsertPerson(db, { id: '3', vorname: 'Unresolved', nachname: 'Person', email: 'u@example.org', gruppen: ['10'], loggedInNow: false });
  db.prepare('UPDATE personen SET ct_person_unresolved = 1 WHERE churchtools_person_id = ?').run('3');

  const app = buildTestApp(db);
  const res = await request(app).get('/admin/personen').set('x-test-person-id', '99');
  assert.equal(res.status, 200);
  assert.match(res.text, /Aktiv Person/);
  assert.match(res.text, /Inaktiv Person/);
  assert.match(res.text, /Unresolved Person/);
  assert.match(res.text, /nicht auflösbar/);
  db.close();
});

test('GET /admin/personen flags a person kept active only via a Konto reference (no ChurchTools group left), and does not flag a normal group member', async () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '99', vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'], loggedInNow: true });
  upsertPerson(db, { id: '4', vorname: 'Konto', nachname: 'Referenziert', email: 'k@example.org', gruppen: [], loggedInNow: false });

  const app = buildTestApp(db);
  const res = await request(app).get('/admin/personen').set('x-test-person-id', '99');
  assert.equal(res.status, 200);
  assert.match(res.text, /Nicht mehr in einer ChurchTools-Gruppe/);

  const adminRow = res.text.slice(res.text.indexOf('Admina Portal'), res.text.indexOf('Admina Portal') + 500);
  assert.doesNotMatch(adminRow, /Nicht mehr in einer ChurchTools-Gruppe/, 'a person still in a real ChurchTools group must not be flagged');
  db.close();
});

test('GET /admin/personen shows a role badge per person and rights checkboxes, disabled for a Manager viewer', async () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '99', vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'], loggedInNow: true });
  upsertPerson(db, { id: '55', vorname: 'Mana', nachname: 'Ger', email: 'manager@example.org', gruppen: ['30'], loggedInNow: false });
  const app = buildTestApp(db);

  const asSuperadmin = await request(app).get('/admin/personen').set('x-test-person-id', '99');
  assert.match(asSuperadmin.text, /Superadmin/);
  assert.match(asSuperadmin.text, /Manager/);
  // Note: the assertion is scoped to <tbody> (not the whole page) because the shared
  // _brand_styles.ejs partial legitimately contains the substring "disabled" in unrelated
  // Bootstrap CSS custom-property names (e.g. --bs-btn-disabled-bg) on every page.
  const superadminTbody = asSuperadmin.text.slice(asSuperadmin.text.indexOf('<tbody>'), asSuperadmin.text.indexOf('</tbody>'));
  assert.doesNotMatch(superadminTbody, /disabled/, 'superadmin must be able to edit the checkboxes');

  const asManager = await request(app).get('/admin/personen').set('x-test-person-id', '55');
  assert.equal(asManager.status, 200);
  const managerTbody = asManager.text.slice(asManager.text.indexOf('<tbody>'), asManager.text.indexOf('</tbody>'));
  assert.match(managerTbody, /disabled/, 'manager must see read-only checkboxes');
  db.close();
});

test('POST /admin/personen/:id/berechtigungen returns 403 for a Manager', async () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '55', vorname: 'Mana', nachname: 'Ger', email: 'manager@example.org', gruppen: ['30'], loggedInNow: true });
  upsertPerson(db, { id: '1', vorname: 'Ziel', nachname: 'Person', email: 'z@example.org', gruppen: [], loggedInNow: false });
  const app = buildTestApp(db);
  const res = await request(app)
    .post('/admin/personen/1/berechtigungen')
    .type('form')
    .set('x-test-person-id', '55')
    .send({ berechtigungen: ['konten_verwalten'] });
  assert.equal(res.status, 403);
  db.close();
});

test('POST /admin/personen/:id/berechtigungen sets the given rights for a Superadmin, and clears them when none are submitted', async () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '99', vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'], loggedInNow: true });
  upsertPerson(db, { id: '1', vorname: 'Ziel', nachname: 'Person', email: 'z@example.org', gruppen: [], loggedInNow: false });
  const app = buildTestApp(db);

  const res = await request(app)
    .post('/admin/personen/1/berechtigungen')
    .type('form')
    .set('x-test-person-id', '99')
    .send({ berechtigungen: ['konten_verwalten', 'mails_einsehen'] });
  assert.equal(res.status, 302);
  assert.deepEqual(listBerechtigungenForPerson(db, '1').sort(), ['konten_verwalten', 'mails_einsehen']);

  await request(app).post('/admin/personen/1/berechtigungen').type('form').set('x-test-person-id', '99').send({});
  assert.deepEqual(listBerechtigungenForPerson(db, '1'), []);
  db.close();
});

test('POST /admin/personen/:id/berechtigungen ignores a value outside the catalog instead of crashing', async () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '99', vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'], loggedInNow: true });
  upsertPerson(db, { id: '1', vorname: 'Ziel', nachname: 'Person', email: 'z@example.org', gruppen: [], loggedInNow: false });
  const app = buildTestApp(db);
  const res = await request(app)
    .post('/admin/personen/1/berechtigungen')
    .type('form')
    .set('x-test-person-id', '99')
    .send({ berechtigungen: ['konten_verwalten', 'basis_einstellungen'] });
  assert.equal(res.status, 302);
  assert.deepEqual(listBerechtigungenForPerson(db, '1'), ['konten_verwalten']);
  db.close();
});

test('POST /admin/personen/:id/berechtigungen returns 404 for a person that does not exist', async () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '99', vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'], loggedInNow: true });
  const app = buildTestApp(db);
  const res = await request(app)
    .post('/admin/personen/does-not-exist/berechtigungen')
    .type('form')
    .set('x-test-person-id', '99')
    .send({ berechtigungen: ['konten_verwalten'] });
  assert.equal(res.status, 404);
  db.close();
});
