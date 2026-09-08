import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { openDatabase } from '../../../src/db/index.js';
import { seedDefaults, getConfigValue } from '../../../src/db/adminConfigRepo.js';
import { upsertPerson } from '../../../src/db/personenRepo.js';
import { loadCurrentPerson, requireRole } from '../../../src/middleware/roles.js';
import { loadNavFlags } from '../../../src/middleware/nav.js';
import { createMailEinstellungenRouter } from '../../../src/routes/admin/mailEinstellungen.js';

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
  const config = { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20', groupIdManager: '30' }, publicBaseUrl: 'http://portal.example.org' };
  app.use(loadCurrentPerson(db));
  app.use(loadNavFlags(db, config));
  const mailer = { sent: [], async sendMail(mail) { this.sent.push(mail); } };
  app.use('/admin/mail-einstellungen', requireRole(config, 'superadmin'), createMailEinstellungenRouter({ db, config, mailer }));
  return app;
}

function seedAdmin(db) {
  upsertPerson(db, { id: '99', vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'], loggedInNow: true });
}

const MAIL_EINSTELLUNGEN_ROUTES = [
  { method: 'get', path: '/admin/mail-einstellungen' },
  { method: 'post', path: '/admin/mail-einstellungen' },
];

const VALID_BODY = {
  zuweisungBetreff: 'B1', zuweisungText: 'T1',
  reminderBetreff: 'B2', reminderText: 'T2',
  eskalationBetreff: 'B3', eskalationText: 'T3',
  ablehnungBetreff: 'B4', ablehnungText: 'T4',
  syncFehlerBetreff: 'B5', syncFehlerText: 'T5',
  ibanWarnungBetreff: 'B6', ibanWarnungText: 'T6',
  rechnungsnummerWarnungBetreff: 'B7', rechnungsnummerWarnungText: 'T7',
  digestBetreff: 'B8', digestText: 'T8',
  freigabe2ReminderBetreff: 'B9', freigabe2ReminderText: 'T9',
  freigabe2EskalationBetreff: 'B10', freigabe2EskalationText: 'T10',
  batchingAktiv: '1',
  batchingStunde: '6',
  batchingMinute: '30',
};

test('every mail-einstellungen route returns 401 without any session, and config is untouched', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  const app = buildTestApp(db);
  for (const { method, path } of MAIL_EINSTELLUNGEN_ROUTES) {
    const res = await request(app)[method](path).type('form').send(VALID_BODY);
    assert.equal(res.status, 401, `${method.toUpperCase()} ${path} should be 401 without a session`);
  }
  assert.equal(getConfigValue(db, 'mail_batching_aktiv'), '0');
  db.close();
});

test('every mail-einstellungen route returns 403 for a logged-in non-superadmin (Manager)', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  upsertPerson(db, { id: '55', vorname: 'Mana', nachname: 'Ger', email: 'manager@example.org', gruppen: ['30'], loggedInNow: true });
  const app = buildTestApp(db);
  for (const { method, path } of MAIL_EINSTELLUNGEN_ROUTES) {
    const res = await request(app)[method](path).set('x-test-person-id', '55').type('form').send(VALID_BODY);
    assert.equal(res.status, 403, `${method.toUpperCase()} ${path} should be 403 for a non-superadmin`);
  }
  db.close();
});

test('GET /admin/mail-einstellungen shows the current templates and batching config', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  const app = buildTestApp(db);
  const res = await request(app).get('/admin/mail-einstellungen').set('x-test-person-id', '99');
  assert.equal(res.status, 200);
  assert.match(res.text, /Freigabeportal: Neue Rechnung zur Bearbeitung/);
  assert.match(res.text, /name="batchingAktiv"/);
});

test('POST /admin/mail-einstellungen saves all 8 templates and the batching config', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  const app = buildTestApp(db);
  const res = await request(app).post('/admin/mail-einstellungen').set('x-test-person-id', '99').type('form').send(VALID_BODY);
  assert.equal(res.status, 302);
  assert.equal(getConfigValue(db, 'mail_vorlage_zuweisung_betreff'), 'B1');
  assert.equal(getConfigValue(db, 'mail_vorlage_digest_text'), 'T8');
  assert.equal(getConfigValue(db, 'mail_batching_aktiv'), '1');
  assert.equal(getConfigValue(db, 'mail_batching_stunde'), '6');
  assert.equal(getConfigValue(db, 'mail_batching_minute'), '30');
  db.close();
});

test('POST /admin/mail-einstellungen persists the freigabe2 template fields', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  const app = buildTestApp(db);
  const res = await request(app).post('/admin/mail-einstellungen').set('x-test-person-id', '99').type('form').send(VALID_BODY);
  assert.equal(res.status, 302);
  assert.equal(getConfigValue(db, 'mail_vorlage_freigabe2_reminder_betreff'), 'B9');
  assert.equal(getConfigValue(db, 'mail_vorlage_freigabe2_reminder_text'), 'T9');
  assert.equal(getConfigValue(db, 'mail_vorlage_freigabe2_eskalation_betreff'), 'B10');
  assert.equal(getConfigValue(db, 'mail_vorlage_freigabe2_eskalation_text'), 'T10');
  db.close();
});

test('POST /admin/mail-einstellungen rejects an empty freigabe2ReminderBetreff', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  const app = buildTestApp(db);
  const res = await request(app)
    .post('/admin/mail-einstellungen')
    .set('x-test-person-id', '99')
    .type('form')
    .send({ ...VALID_BODY, freigabe2ReminderBetreff: '' });
  assert.equal(res.status, 400);
  db.close();
});

test('POST /admin/mail-einstellungen with batchingAktiv absent (checkbox unchecked) turns batching off', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  const app = buildTestApp(db);
  const body = { ...VALID_BODY };
  delete body.batchingAktiv;
  const res = await request(app).post('/admin/mail-einstellungen').set('x-test-person-id', '99').type('form').send(body);
  assert.equal(res.status, 302);
  assert.equal(getConfigValue(db, 'mail_batching_aktiv'), '0');
  db.close();
});

test('POST /admin/mail-einstellungen rejects a non-integer batchingStunde', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  const app = buildTestApp(db);
  const res = await request(app).post('/admin/mail-einstellungen').set('x-test-person-id', '99').type('form').send({ ...VALID_BODY, batchingStunde: 'abc' });
  assert.equal(res.status, 400);
  db.close();
});

test('POST /admin/mail-einstellungen/jetzt-ausfuehren triggers runMailDigestJob and redirects back', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  const app = buildTestApp(db);
  const res = await request(app).post('/admin/mail-einstellungen/jetzt-ausfuehren').set('x-test-person-id', '99');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/admin/mail-einstellungen?getriggert=1');
  db.close();
});
