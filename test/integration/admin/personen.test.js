// test/integration/admin/personen.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { openDatabase } from '../../../src/db/index.js';
import { upsertPerson } from '../../../src/db/personenRepo.js';
import { loadCurrentPerson, requireRole } from '../../../src/middleware/roles.js';
import { loadNavFlags } from '../../../src/middleware/nav.js';
import { createPersonenRouter } from '../../../src/routes/admin/personen.js';

function buildTestApp(db) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', new URL('../../../views', import.meta.url).pathname);
  app.use((req, res, next) => {
    res.locals.branding = { primaryColor: '#000', secondaryColor: '#fff', hasLogo: false, themeAttr: null };
    next();
  });
  app.use((req, res, next) => {
    req.session = { personId: req.headers['x-test-person-id'] };
    next();
  });
  const config = { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20' } };
  app.use(loadCurrentPerson(db));
  app.use(loadNavFlags(db, config));
  app.use('/admin/personen', requireRole(config, 'superadmin'), createPersonenRouter({ db }));
  return app;
}

test('GET /admin/personen without a portal-admin session returns 401', async () => {
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
