import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { loadCurrentPerson, requireRole, requireAnyRole, requireLogin, personHasRole } from '../../src/middleware/roles.js';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';

function buildTestApp(db) {
  const config = { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20', groupIdManager: '30' } };
  const app = express();
  app.use((req, res, next) => {
    req.session = { personId: req.headers['x-test-person-id'] };
    next();
  });
  app.set('view engine', 'ejs');
  app.set('views', new URL('../../views', import.meta.url).pathname);
  app.use(loadCurrentPerson(db));
  app.get('/buchhaltung-only', requireRole(config, 'buchhaltung'), (req, res) => res.json({ ok: true }));
  app.get('/admin-only', requireRole(config, 'superadmin'), (req, res) => res.json({ ok: true }));
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

const CONFIG = { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20', groupIdManager: '30' } };

function runMiddleware(db, personId, roles) {
  return new Promise((resolve) => {
    const req = { session: { personId }, currentPerson: null };
    const res = {
      locals: {},
      status(code) {
        this.statusCode = code;
        return this;
      },
      render(view, locals) {
        resolve({ statusCode: this.statusCode, view, locals });
      },
    };
    loadCurrentPerson(db)(req, res, () => {
      requireAnyRole(CONFIG, roles)(req, res, () => resolve({ statusCode: 200, next: true }));
    });
  });
}

test('requireAnyRole allows a person in the first listed role', async () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'Buch', nachname: 'Halter', email: 'buch@example.org', gruppen: ['10'], loggedInNow: false });
  const result = await runMiddleware(db, '1', ['buchhaltung', 'superadmin']);
  assert.equal(result.next, true);
  db.close();
});

test('requireAnyRole allows a person in the second listed role', async () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'], loggedInNow: false });
  const result = await runMiddleware(db, '1', ['buchhaltung', 'superadmin']);
  assert.equal(result.next, true);
  db.close();
});

test('requireAnyRole rejects a person in neither role with 403', async () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'Niemand', nachname: 'Besonderes', email: 'x@example.org', gruppen: [], loggedInNow: false });
  const result = await runMiddleware(db, '1', ['buchhaltung', 'superadmin']);
  assert.equal(result.statusCode, 403);
  db.close();
});

test('requireAnyRole rejects an unauthenticated request with 401', async () => {
  const db = openDatabase(':memory:');
  const result = await runMiddleware(db, undefined, ['buchhaltung', 'superadmin']);
  assert.equal(result.statusCode, 401);
  db.close();
});

function runRequireLogin(db, personId) {
  return new Promise((resolve) => {
    const req = { session: { personId }, currentPerson: null };
    const res = {
      locals: {},
      status(code) {
        this.statusCode = code;
        return this;
      },
      render(view, locals) {
        resolve({ statusCode: this.statusCode, view, locals });
      },
    };
    loadCurrentPerson(db)(req, res, () => {
      requireLogin()(req, res, () => resolve({ statusCode: 200, next: true }));
    });
  });
}

test('requireLogin allows a logged-in active person with no group memberships at all', async () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'Frei', nachname: 'Geber', email: 'frei@example.org', gruppen: [], loggedInNow: false });
  const result = await runRequireLogin(db, '1');
  assert.equal(result.next, true);
  db.close();
});

test('requireLogin returns 401 when nobody is logged in', async () => {
  const db = openDatabase(':memory:');
  const result = await runRequireLogin(db, undefined);
  assert.equal(result.statusCode, 401);
  db.close();
});

test('requireLogin returns 401 for a deactivated person', async () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'A', nachname: 'B', email: 'a@b.ch', gruppen: [], loggedInNow: true });
  db.prepare('UPDATE personen SET aktiv = 0 WHERE churchtools_person_id = ?').run('1');
  const result = await runRequireLogin(db, '1');
  assert.equal(result.statusCode, 401);
  db.close();
});

test('personHasRole returns false for a null person', () => {
  const config = { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20', groupIdManager: '30' } };
  assert.equal(personHasRole(null, config, 'buchhaltung'), false);
});

test('personHasRole checks membership by the role\'s own configured group id', () => {
  const config = { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20', groupIdManager: '30' } };
  const person = { gruppen: ['20'] };
  assert.equal(personHasRole(person, config, 'buchhaltung'), false);
  assert.equal(personHasRole(person, config, 'superadmin'), true);
});

test('personHasRole returns false when the role\'s configured group id is falsy (e.g. CT_GROUP_ID_MANAGER unset)', () => {
  const config = { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20', groupIdManager: null } };
  const person = { gruppen: ['10', '20', 'null'] }; // even a literal "null" group id must not match
  assert.equal(personHasRole(person, config, 'manager'), false);
});

test('personHasRole recognizes manager group membership', () => {
  const config = { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20', groupIdManager: '30' } };
  const person = { gruppen: ['30'] };
  assert.equal(personHasRole(person, config, 'manager'), true);
  assert.equal(personHasRole(person, config, 'superadmin'), false);
});
