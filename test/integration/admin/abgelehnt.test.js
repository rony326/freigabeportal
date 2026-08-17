import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../../src/db/index.js';
import { upsertPerson } from '../../../src/db/personenRepo.js';
import { createKonto } from '../../../src/db/kontenRepo.js';
import { createJob, claimJob, setKontierung, ablehnenJob, getJobById, setThumbnailPfad } from '../../../src/db/jobsRepo.js';
import { createFreigabe, listFreigabenByJob } from '../../../src/db/freigabenRepo.js';
import { listJobLoeschungen } from '../../../src/db/jobLoeschungenRepo.js';
import { loadCurrentPerson, requireRole } from '../../../src/middleware/roles.js';
import { createAdminAbgelehntRouter } from '../../../src/routes/admin/abgelehnt.js';

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
  app.use('/admin/abgelehnt', requireRole(config, 'portal-admin'), createAdminAbgelehntRouter({ db }));
  return app;
}

function seedAdmin(db) {
  upsertPerson(db, { id: '99', vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'], loggedInNow: true });
}

function seedAbgelehntJob(db, dir) {
  for (const id of ['1', '2', '3']) {
    upsertPerson(db, { id, vorname: `Person${id}`, nachname: 'Muster', email: `p${id}@example.org`, gruppen: ['10'], loggedInNow: false });
  }
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '2' });
  const pdfPfad = join(dir, `a-${Date.now()}.pdf`);
  writeFileSync(pdfPfad, '%PDF-1.4\n%test\n');
  const thumbnailPfad = join(dir, `a-${Date.now()}.png`);
  writeFileSync(thumbnailPfad, 'fake-png');
  const id = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'lieferant', absender: 'lief@example.org', dateiname: 'rechnung.pdf', pdfPfad });
  setKontierung(db, id, kontoId);
  setThumbnailPfad(db, id, thumbnailPfad);
  db.prepare("UPDATE jobs SET status = 'freigabe2', zugewiesen_an = '1', lieferant = 'Muster AG' WHERE id = ?").run(id);
  ablehnenJob(db, id, { abgelehntVon: '3', grund: 'Falsches Konto' });
  createFreigabe(db, { jobId: id, personId: '3', rolle: 'ablehnung', zeitpunkt: '2026-08-15T09:00:00.000Z', ip: '1.2.3.4', interessenskonflikt: false, kommentar: 'Falsches Konto', eskaliertVon: null });
  return { id, pdfPfad, thumbnailPfad };
}

test('every /admin/abgelehnt route returns 401 without a session', async () => {
  const db = openDatabase(':memory:');
  const app = buildTestApp(db);
  for (const res of [
    await request(app).get('/admin/abgelehnt'),
    await request(app).get('/admin/abgelehnt/1'),
    await request(app).post('/admin/abgelehnt/1/loeschen'),
  ]) {
    assert.equal(res.status, 401);
  }
  db.close();
});

test('every /admin/abgelehnt route returns 403 for a non-admin (buchhaltung only)', async () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '77', vorname: 'Nur', nachname: 'Buchhaltung', email: 'b@example.org', gruppen: ['10'], loggedInNow: true });
  const app = buildTestApp(db);
  const res = await request(app).get('/admin/abgelehnt').set('x-test-person-id', '77');
  assert.equal(res.status, 403);
  db.close();
});

test('GET /admin/abgelehnt lists every rejected job regardless of who it is assigned to, with the rejecter\'s name', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  const dir = mkdtempSync(join(tmpdir(), 'abgelehnt-test-'));
  const { id } = seedAbgelehntJob(db, dir);
  const app = buildTestApp(db);

  const res = await request(app).get('/admin/abgelehnt').set('x-test-person-id', '99');
  assert.equal(res.status, 200);
  assert.match(res.text, /rechnung\.pdf/);
  assert.match(res.text, /Muster AG/);
  assert.match(res.text, /Falsches Konto/);
  assert.match(res.text, /Person3/);
  assert.match(res.text, new RegExp(`href="/admin/abgelehnt/${id}"`));
  db.close();
});

test('GET /admin/abgelehnt/:id shows the confirmation form for a rejected job', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  const dir = mkdtempSync(join(tmpdir(), 'abgelehnt-test-'));
  const { id } = seedAbgelehntJob(db, dir);
  const app = buildTestApp(db);

  const res = await request(app).get(`/admin/abgelehnt/${id}`).set('x-test-person-id', '99');
  assert.equal(res.status, 200);
  assert.match(res.text, /name="begruendung"/);
  assert.match(res.text, /name="bestaetigung"/);
  db.close();
});

test('GET /admin/abgelehnt/:id returns 404 for a job that is not (or no longer) abgelehnt', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  const id = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  const app = buildTestApp(db);
  const res = await request(app).get(`/admin/abgelehnt/${id}`).set('x-test-person-id', '99');
  assert.equal(res.status, 404);
  db.close();
});

test('POST /admin/abgelehnt/:id/loeschen deletes the job, its files, its freigaben, and logs the deletion', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  const dir = mkdtempSync(join(tmpdir(), 'abgelehnt-test-'));
  const { id, pdfPfad, thumbnailPfad } = seedAbgelehntJob(db, dir);
  const app = buildTestApp(db);

  const res = await request(app)
    .post(`/admin/abgelehnt/${id}/loeschen`)
    .set('x-test-person-id', '99')
    .type('form')
    .send({ begruendung: 'Duplikat, versehentlich zweimal hochgeladen', bestaetigung: 'ja' });

  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/admin/abgelehnt?gespeichert=1');
  assert.equal(getJobById(db, id), null);
  assert.equal(listFreigabenByJob(db, id).length, 0);
  assert.equal(existsSync(pdfPfad), false, 'the PDF file should have been deleted');
  assert.equal(existsSync(thumbnailPfad), false, 'the thumbnail file should have been deleted');

  const log = listJobLoeschungen(db);
  assert.equal(log.length, 1);
  assert.equal(log[0].job_id, id);
  assert.equal(log[0].dateiname, 'rechnung.pdf');
  assert.equal(log[0].geloescht_von, '99');
  assert.equal(log[0].begruendung, 'Duplikat, versehentlich zweimal hochgeladen');
  db.close();
});

test('POST /admin/abgelehnt/:id/loeschen without a Begründung is rejected, nothing deleted', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  const dir = mkdtempSync(join(tmpdir(), 'abgelehnt-test-'));
  const { id } = seedAbgelehntJob(db, dir);
  const app = buildTestApp(db);

  const res = await request(app)
    .post(`/admin/abgelehnt/${id}/loeschen`)
    .set('x-test-person-id', '99')
    .type('form')
    .send({ begruendung: '', bestaetigung: 'ja' });

  assert.equal(res.status, 400);
  assert.match(res.text, /Eine Begründung ist Pflicht/);
  assert.ok(getJobById(db, id));
  db.close();
});

test('POST /admin/abgelehnt/:id/loeschen without the Bestätigung checkbox is rejected, nothing deleted', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  const dir = mkdtempSync(join(tmpdir(), 'abgelehnt-test-'));
  const { id } = seedAbgelehntJob(db, dir);
  const app = buildTestApp(db);

  const res = await request(app)
    .post(`/admin/abgelehnt/${id}/loeschen`)
    .set('x-test-person-id', '99')
    .type('form')
    .send({ begruendung: 'Duplikat', bestaetigung: '' });

  assert.equal(res.status, 400);
  assert.match(res.text, /Bitte die Löschung bestätigen/);
  assert.ok(getJobById(db, id));
  db.close();
});

test('POST /admin/abgelehnt/:id/loeschen for a job that is not abgelehnt returns 404, nothing deleted', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  const id = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  const app = buildTestApp(db);

  const res = await request(app)
    .post(`/admin/abgelehnt/${id}/loeschen`)
    .set('x-test-person-id', '99')
    .type('form')
    .send({ begruendung: 'Duplikat', bestaetigung: 'ja' });

  assert.equal(res.status, 404);
  assert.ok(getJobById(db, id));
  db.close();
});
