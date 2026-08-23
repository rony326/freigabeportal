import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { openDatabase } from '../../../src/db/index.js';
import { seedDefaults, getConfigValue } from '../../../src/db/adminConfigRepo.js';
import { upsertPerson } from '../../../src/db/personenRepo.js';
import { createKonto } from '../../../src/db/kontenRepo.js';
import { createJob, getJobById } from '../../../src/db/jobsRepo.js';
import { loadCurrentPerson } from '../../../src/middleware/roles.js';
import { loadNavFlags } from '../../../src/middleware/nav.js';
import { requirePermission } from '../../../src/middleware/permissions.js';
import { setBerechtigungenForPerson } from '../../../src/db/personBerechtigungenRepo.js';
import { createSyncRouter } from '../../../src/routes/admin/sync.js';

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
  app.use('/admin/sync', requirePermission(db, config, 'sync_einsehen'), createSyncRouter({ db }));
  return app;
}

function seedAdmin(db) {
  upsertPerson(db, { id: '99', vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'], loggedInNow: true });
}

test('GET /admin/sync returns 401 without a session', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  const app = buildTestApp(db);
  const res = await request(app).get('/admin/sync');
  assert.equal(res.status, 401);
  db.close();
});

test('GET /admin/sync returns 403 for a non-admin', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  upsertPerson(db, { id: '77', vorname: 'Nur', nachname: 'Buchhaltung', email: 'b@example.org', gruppen: ['10'], loggedInNow: true });
  const app = buildTestApp(db);
  const res = await request(app).get('/admin/sync').set('x-test-person-id', '77');
  assert.equal(res.status, 403);
  db.close();
});

test('GET /admin/sync renders the current thresholds', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  const app = buildTestApp(db);
  const res = await request(app).get('/admin/sync').set('x-test-person-id', '99');
  assert.equal(res.status, 200);
  assert.match(res.text, /50/);
  assert.match(res.text, /10/);
  db.close();
});

test('POST /admin/sync updates the three config values', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  const app = buildTestApp(db);
  const res = await request(app)
    .post('/admin/sync')
    .set('x-test-person-id', '99')
    .type('form')
    .send({ maxDeaktivierungProzent: '40', maxDeaktivierungAnzahl: '5', syncFehlerEmpfaenger: 'gruppe:admin' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/admin/sync?gespeichert=1');
  assert.equal(getConfigValue(db, 'sync_max_deaktivierung_prozent'), '40');
  assert.equal(getConfigValue(db, 'sync_max_deaktivierung_anzahl'), '5');
  db.close();
});

test('GET /admin/sync?gespeichert=1 shows the save confirmation; without it, it does not', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  const app = buildTestApp(db);
  const withMarker = await request(app).get('/admin/sync?gespeichert=1').set('x-test-person-id', '99');
  assert.match(withMarker.text, /Gespeichert\./);
  const withoutMarker = await request(app).get('/admin/sync').set('x-test-person-id', '99');
  assert.doesNotMatch(withoutMarker.text, /Gespeichert\./);
  db.close();
});

test('POST /admin/sync rejects an invalid percent value and does not persist it', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  const app = buildTestApp(db);
  const res = await request(app)
    .post('/admin/sync')
    .set('x-test-person-id', '99')
    .type('form')
    .send({ maxDeaktivierungProzent: '0', maxDeaktivierungAnzahl: '5', syncFehlerEmpfaenger: 'gruppe:admin' });
  assert.equal(res.status, 400);
  assert.equal(getConfigValue(db, 'sync_max_deaktivierung_prozent'), '50');
  db.close();
});

test('GET /admin/sync lists stalled jobs with a force-release action', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  upsertPerson(db, { id: '1', vorname: 'Freigeber', nachname: 'Eins', email: 'f1@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '2', vorname: 'Stellvertreter', nachname: 'Eins', email: 's1@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '3', vorname: 'Freigeber', nachname: 'Zwei', email: 'f2@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '4', vorname: 'Stellvertreter', nachname: 'Zwei', email: 's2@example.org', gruppen: ['10'], loggedInNow: false });
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  const jobId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare("UPDATE jobs SET status = 'zugewiesen', zugewiesen_an = '1', konto_id = ? WHERE id = ?").run(kontoId, jobId);
  db.prepare("UPDATE personen SET aktiv = 0 WHERE churchtools_person_id = '1'").run();

  const app = buildTestApp(db);
  const res = await request(app).get('/admin/sync').set('x-test-person-id', '99');
  assert.equal(res.status, 200);
  assert.match(res.text, /a\.pdf/);
  assert.match(res.text, new RegExp(`/admin/sync/stalled/${jobId}/freigeben`));
  db.close();
});

test('POST /admin/sync/stalled/:jobId/freigeben force-releases a stalled zugewiesen job', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  upsertPerson(db, { id: '1', vorname: 'Freigeber', nachname: 'Eins', email: 'f1@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '2', vorname: 'Stellvertreter', nachname: 'Eins', email: 's1@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '3', vorname: 'Freigeber', nachname: 'Zwei', email: 'f2@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '4', vorname: 'Stellvertreter', nachname: 'Zwei', email: 's2@example.org', gruppen: ['10'], loggedInNow: false });
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  const jobId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare("UPDATE jobs SET status = 'zugewiesen', zugewiesen_an = '1', konto_id = ? WHERE id = ?").run(kontoId, jobId);
  db.prepare("UPDATE personen SET aktiv = 0 WHERE churchtools_person_id = '1'").run();

  const app = buildTestApp(db);
  const res = await request(app).post(`/admin/sync/stalled/${jobId}/freigeben`).set('x-test-person-id', '99');
  assert.equal(res.status, 302);
  assert.equal(getJobById(db, jobId).status, 'unzugewiesen');
  db.close();
});

test('POST /admin/sync/stalled/:jobId/freigeben escalates a stalled freigabe2 job to admin instead of releasing it', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  upsertPerson(db, { id: '1', vorname: 'Freigeber', nachname: 'Eins', email: 'f1@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '2', vorname: 'Stellvertreter', nachname: 'Eins', email: 's1@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '3', vorname: 'Freigeber', nachname: 'Zwei', email: 'f2@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '4', vorname: 'Stellvertreter', nachname: 'Zwei', email: 's2@example.org', gruppen: ['10'], loggedInNow: false });
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  const jobId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare("UPDATE jobs SET status = 'freigabe2', konto_id = ? WHERE id = ?").run(kontoId, jobId);
  db.prepare("UPDATE personen SET aktiv = 0 WHERE churchtools_person_id = '3'").run();

  const app = buildTestApp(db);
  const res = await request(app).post(`/admin/sync/stalled/${jobId}/freigeben`).set('x-test-person-id', '99');
  assert.equal(res.status, 302);
  const job = getJobById(db, jobId);
  assert.equal(job.status, 'freigabe2');
  assert.equal(job.freigabe2_eskaliert_an_admin, 1);
  db.close();
});

test('GET /admin/sync returns 200 for a Manager', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  upsertPerson(db, { id: '55', vorname: 'Mana', nachname: 'Ger', email: 'manager@example.org', gruppen: ['30'], loggedInNow: true });
  const app = buildTestApp(db);
  const res = await request(app).get('/admin/sync').set('x-test-person-id', '55');
  assert.equal(res.status, 200);
  db.close();
});

test('GET /admin/sync returns 200 for a plain person with exactly this individual grant, and 403 for a different one', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  upsertPerson(db, { id: '1', vorname: 'Nur', nachname: 'Mails', email: 'nur@example.org', gruppen: [], loggedInNow: true });
  setBerechtigungenForPerson(db, '1', ['mails_einsehen']);
  const app = buildTestApp(db);
  const res = await request(app).get('/admin/sync').set('x-test-person-id', '1');
  assert.equal(res.status, 403);

  setBerechtigungenForPerson(db, '1', ['sync_einsehen']);
  const res2 = await request(app).get('/admin/sync').set('x-test-person-id', '1');
  assert.equal(res2.status, 200);
  db.close();
});
