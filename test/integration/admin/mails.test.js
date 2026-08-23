import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { openDatabase } from '../../../src/db/index.js';
import { upsertPerson } from '../../../src/db/personenRepo.js';
import { logMailAttempt, listMailLog } from '../../../src/db/mailLogRepo.js';
import { loadCurrentPerson } from '../../../src/middleware/roles.js';
import { loadNavFlags } from '../../../src/middleware/nav.js';
import { requirePermission } from '../../../src/middleware/permissions.js';
import { setBerechtigungenForPerson } from '../../../src/db/personBerechtigungenRepo.js';
import { createMailsRouter } from '../../../src/routes/admin/mails.js';

function createStubMailer({ shouldFail = false } = {}) {
  const sent = [];
  return { sent, async sendMail(mail) { sent.push(mail); if (shouldFail) throw new Error('SMTP-Testfehler'); } };
}

function buildTestApp(db, mailer) {
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
  app.use('/admin/mails', requirePermission(db, config, 'mails_einsehen'), createMailsRouter({ db, mailer }));
  return app;
}

function seedAdmin(db) {
  upsertPerson(db, { id: '99', vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'], loggedInNow: true });
}

test('GET /admin/mails returns 401 without a session', async () => {
  const db = openDatabase(':memory:');
  const app = buildTestApp(db, createStubMailer());
  const res = await request(app).get('/admin/mails');
  assert.equal(res.status, 401);
  db.close();
});

test('GET /admin/mails lists logged attempts with an Erneut-versenden button only for fehlgeschlagen rows', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  logMailAttempt(db, { typ: 'reminder', jobId: null, empfaenger: 'ok@example.org', betreff: 'Erfolg', text: 'T', status: 'versendet' });
  logMailAttempt(db, { typ: 'eskalation', jobId: null, empfaenger: 'fail@example.org', betreff: 'Fehler', text: 'T', status: 'fehlgeschlagen', fehlerDetails: 'SMTP down' });
  const app = buildTestApp(db, createStubMailer());

  const res = await request(app).get('/admin/mails').set('x-test-person-id', '99');
  assert.equal(res.status, 200);
  assert.match(res.text, /ok@example\.org/);
  assert.match(res.text, /fail@example\.org/);
  assert.match(res.text, /SMTP down/);
  db.close();
});

test('POST /admin/mails/:id/erneut-versenden resends and appends a new versendet row', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  const id = logMailAttempt(db, { typ: 'reminder', jobId: null, empfaenger: 'x@example.org', betreff: 'B', text: 'T', status: 'fehlgeschlagen', fehlerDetails: 'SMTP down' });
  const mailer = createStubMailer();
  const app = buildTestApp(db, mailer);

  const res = await request(app).post(`/admin/mails/${id}/erneut-versenden`).set('x-test-person-id', '99');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/admin/mails?gespeichert=1');
  assert.equal(mailer.sent.length, 1);
  assert.equal(mailer.sent[0].to, 'x@example.org');

  const rows = listMailLog(db);
  assert.equal(rows.length, 2, 'the original failed row stays, a new row is appended');
  assert.equal(rows[0].status, 'versendet', 'the newest row (retry) is versendet');
  db.close();
});

test('GET /admin/mails?gespeichert=1 shows "Erneut gesendet."; without it, it does not', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  const app = buildTestApp(db);
  const withMarker = await request(app).get('/admin/mails?gespeichert=1').set('x-test-person-id', '99');
  assert.match(withMarker.text, /Erneut gesendet\./);
  const withoutMarker = await request(app).get('/admin/mails').set('x-test-person-id', '99');
  assert.doesNotMatch(withoutMarker.text, /Erneut gesendet\./);
  db.close();
});

test('POST /admin/mails/:id/erneut-versenden for an unknown id returns 404', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  const app = buildTestApp(db, createStubMailer());
  const res = await request(app).post('/admin/mails/999/erneut-versenden').set('x-test-person-id', '99');
  assert.equal(res.status, 404);
  db.close();
});

test('GET /admin/mails returns 200 for a Manager', async () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '55', vorname: 'Mana', nachname: 'Ger', email: 'manager@example.org', gruppen: ['30'], loggedInNow: true });
  const app = buildTestApp(db);
  const res = await request(app).get('/admin/mails').set('x-test-person-id', '55');
  assert.equal(res.status, 200);
  db.close();
});

test('GET /admin/mails returns 200 for a plain person with exactly this individual grant, and 403 for a different one', async () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'Nur', nachname: 'Sync', email: 'nur@example.org', gruppen: [], loggedInNow: true });
  setBerechtigungenForPerson(db, '1', ['sync_einsehen']);
  const app = buildTestApp(db);
  const res = await request(app).get('/admin/mails').set('x-test-person-id', '1');
  assert.equal(res.status, 403);

  setBerechtigungenForPerson(db, '1', ['mails_einsehen']);
  const res2 = await request(app).get('/admin/mails').set('x-test-person-id', '1');
  assert.equal(res2.status, 200);
  db.close();
});
