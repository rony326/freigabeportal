import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { loadCurrentPerson, requireRole } from '../../src/middleware/roles.js';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';

function buildTestApp(db) {
  const config = { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20' } };
  const app = express();
  app.use((req, res, next) => {
    req.session = { personId: req.headers['x-test-person-id'] };
    next();
  });
  app.set('view engine', 'ejs');
  app.set('views', new URL('../../views', import.meta.url).pathname);
  app.use(loadCurrentPerson(db));
  app.get('/buchhaltung-only', requireRole(config, 'buchhaltung'), (req, res) => res.json({ ok: true }));
  app.get('/admin-only', requireRole(config, 'portal-admin'), (req, res) => res.json({ ok: true }));
  return app;
}

test('requireRole returns 401 when nobody is logged in', async () => {
  const db = openDatabase(':memory:');
  const app = buildTestApp(db);
  const res = await request(app).get('/buchhaltung-only');
  assert.equal(res.status, 401);
  db.close();
});

test('requireRole returns 403 when logged in but missing the group', async () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'A', nachname: 'B', email: 'a@b.ch', gruppen: ['20'], loggedInNow: true });
  const app = buildTestApp(db);
  const res = await request(app).get('/buchhaltung-only').set('x-test-person-id', '1');
  assert.equal(res.status, 403);
  db.close();
});

test('requireRole calls next when the person has the required group', async () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'A', nachname: 'B', email: 'a@b.ch', gruppen: ['10'], loggedInNow: true });
  const app = buildTestApp(db);
  const res = await request(app).get('/buchhaltung-only').set('x-test-person-id', '1');
  assert.equal(res.status, 200);
  db.close();
});

test('requireRole returns 401 for a deactivated person', async () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'A', nachname: 'B', email: 'a@b.ch', gruppen: ['10'], loggedInNow: true });
  db.prepare('UPDATE personen SET aktiv = 0 WHERE churchtools_person_id = ?').run('1');
  const app = buildTestApp(db);
  const res = await request(app).get('/buchhaltung-only').set('x-test-person-id', '1');
  assert.equal(res.status, 401);
  db.close();
});
