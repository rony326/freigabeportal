import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { setBerechtigungenForPerson } from '../../src/db/personBerechtigungenRepo.js';
import { loadCurrentPerson } from '../../src/middleware/roles.js';
import { GRANTABLE_BERECHTIGUNGEN, personHasPermission, requirePermission, requireAdminAreaAccess } from '../../src/middleware/permissions.js';

const CONFIG = { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20', groupIdManager: '30' } };

test('GRANTABLE_BERECHTIGUNGEN lists exactly the six catalog permissions', () => {
  assert.deepEqual(
    [...GRANTABLE_BERECHTIGUNGEN].sort(),
    ['abgelehnt_verwalten', 'debitoren_verwalten', 'geplante_jobs_verwalten', 'konten_verwalten', 'mails_einsehen', 'sync_einsehen']
  );
});

test('personHasPermission: superadmin has every grantable permission without any individual grant', () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'A', nachname: 'B', email: 'a@b.ch', gruppen: ['20'], loggedInNow: false });
  const person = { churchtools_person_id: '1', gruppen: ['20'] };
  for (const permission of GRANTABLE_BERECHTIGUNGEN) {
    assert.equal(personHasPermission(db, CONFIG, person, permission), true, permission);
  }
  db.close();
});

test('personHasPermission: manager has every grantable permission without any individual grant', () => {
  const db = openDatabase(':memory:');
  const person = { churchtools_person_id: '1', gruppen: ['30'] };
  for (const permission of GRANTABLE_BERECHTIGUNGEN) {
    assert.equal(personHasPermission(db, CONFIG, person, permission), true, permission);
  }
  db.close();
});

test('personHasPermission: a plain person only has an individually granted permission', () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'A', nachname: 'B', email: 'a@b.ch', gruppen: [], loggedInNow: false });
  setBerechtigungenForPerson(db, '1', ['debitoren_verwalten']);
  const person = { churchtools_person_id: '1', gruppen: [] };
  assert.equal(personHasPermission(db, CONFIG, person, 'debitoren_verwalten'), true);
  assert.equal(personHasPermission(db, CONFIG, person, 'konten_verwalten'), false);
  db.close();
});

test('personHasPermission returns false for a null person', () => {
  const db = openDatabase(':memory:');
  assert.equal(personHasPermission(db, CONFIG, null, 'konten_verwalten'), false);
  db.close();
});

function buildPermissionTestApp(db) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', new URL('../../views', import.meta.url).pathname);
  app.use((req, res, next) => {
    req.session = { personId: req.headers['x-test-person-id'] };
    next();
  });
  app.use(loadCurrentPerson(db));
  app.get('/needs-konten', requirePermission(db, CONFIG, 'konten_verwalten'), (req, res) => res.json({ ok: true }));
  app.get('/admin-area', requireAdminAreaAccess(db, CONFIG), (req, res) => res.json({ ok: true }));
  return app;
}

test('requirePermission returns 401 when nobody is logged in', async () => {
  const db = openDatabase(':memory:');
  const app = buildPermissionTestApp(db);
  const res = await request(app).get('/needs-konten');
  assert.equal(res.status, 401);
  db.close();
});

test('requirePermission returns 403 for a logged-in person without the permission', async () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'A', nachname: 'B', email: 'a@b.ch', gruppen: [], loggedInNow: true });
  const app = buildPermissionTestApp(db);
  const res = await request(app).get('/needs-konten').set('x-test-person-id', '1');
  assert.equal(res.status, 403);
  db.close();
});

test('requirePermission calls next for a person with the individual grant', async () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'A', nachname: 'B', email: 'a@b.ch', gruppen: [], loggedInNow: true });
  setBerechtigungenForPerson(db, '1', ['konten_verwalten']);
  const app = buildPermissionTestApp(db);
  const res = await request(app).get('/needs-konten').set('x-test-person-id', '1');
  assert.equal(res.status, 200);
  db.close();
});

test('requireAdminAreaAccess rejects a person with zero roles and zero individual grants', async () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'A', nachname: 'B', email: 'a@b.ch', gruppen: [], loggedInNow: true });
  const app = buildPermissionTestApp(db);
  const res = await request(app).get('/admin-area').set('x-test-person-id', '1');
  assert.equal(res.status, 403);
  db.close();
});

test('requireAdminAreaAccess allows a person with exactly one individual grant', async () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'A', nachname: 'B', email: 'a@b.ch', gruppen: [], loggedInNow: true });
  setBerechtigungenForPerson(db, '1', ['mails_einsehen']);
  const app = buildPermissionTestApp(db);
  const res = await request(app).get('/admin-area').set('x-test-person-id', '1');
  assert.equal(res.status, 200);
  db.close();
});

test('requireAdminAreaAccess allows a manager with zero individual grants', async () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'A', nachname: 'B', email: 'a@b.ch', gruppen: ['30'], loggedInNow: true });
  const app = buildPermissionTestApp(db);
  const res = await request(app).get('/admin-area').set('x-test-person-id', '1');
  assert.equal(res.status, 200);
  db.close();
});
