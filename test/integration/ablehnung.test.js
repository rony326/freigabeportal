import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createKonto } from '../../src/db/kontenRepo.js';
import { createJob, setKontierung, ablehnenJob, getJobById } from '../../src/db/jobsRepo.js';
import { createFreigabe } from '../../src/db/freigabenRepo.js';
import { loadCurrentPerson, requireRole } from '../../src/middleware/roles.js';
import { createAblehnungRouter } from '../../src/routes/ablehnung.js';

function buildTestApp(db) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', new URL('../../views', import.meta.url).pathname);
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
  app.use('/abgelehnt', requireRole(config, 'buchhaltung'), createAblehnungRouter({ db }));
  return app;
}

const ABLEHNUNG_ZEITPUNKT = '2026-08-15T09:45:00.000Z';

async function seedAbgelehntJob(db) {
  for (const id of ['1', '2', '3']) {
    upsertPerson(db, { id, vorname: `Person${id}`, nachname: 'Muster', email: `p${id}@example.org`, gruppen: ['10'], loggedInNow: true });
  }
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '2' });
  const id = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  setKontierung(db, id, kontoId);
  db.prepare("UPDATE jobs SET status = 'freigabe2', zugewiesen_an = '1' WHERE id = ?").run(id);
  ablehnenJob(db, id, { abgelehntVon: '3', grund: 'Falsches Konto gewählt' });
  createFreigabe(db, {
    jobId: id,
    personId: '3',
    rolle: 'ablehnung',
    zeitpunkt: ABLEHNUNG_ZEITPUNKT,
    ip: '9.9.9.9',
    interessenskonflikt: false,
    kommentar: 'Falsches Konto gewählt',
    eskaliertVon: null,
  });
  return { id, kontoId };
}

test('GET /abgelehnt/:id returns 403 for a person other than zugewiesen_an', async () => {
  const db = openDatabase(':memory:');
  const { id } = await seedAbgelehntJob(db);
  const app = buildTestApp(db);
  const res = await request(app).get(`/abgelehnt/${id}`).set('x-test-person-id', '3');
  assert.equal(res.status, 403);
  db.close();
});

test('GET /abgelehnt/:id returns 403 when the job is not in status abgelehnt', async () => {
  const db = openDatabase(':memory:');
  const { id } = await seedAbgelehntJob(db);
  const { wiederOeffnenJob } = await import('../../src/db/jobsRepo.js');
  wiederOeffnenJob(db, id, '1');
  const app = buildTestApp(db);
  const res = await request(app).get(`/abgelehnt/${id}`).set('x-test-person-id', '1');
  assert.equal(res.status, 403);
  db.close();
});

test('GET /abgelehnt/:id shows the rejection reason and who rejected it', async () => {
  const db = openDatabase(':memory:');
  const { id } = await seedAbgelehntJob(db);
  const app = buildTestApp(db);
  const res = await request(app).get(`/abgelehnt/${id}`).set('x-test-person-id', '1');
  assert.equal(res.status, 200);
  assert.match(res.text, /Falsches Konto gewählt/);
  assert.match(res.text, /Person3/);
  db.close();
});

test('GET /abgelehnt/:id shows when the rejection happened', async () => {
  const db = openDatabase(':memory:');
  const { id } = await seedAbgelehntJob(db);
  const app = buildTestApp(db);
  const res = await request(app).get(`/abgelehnt/${id}`).set('x-test-person-id', '1');
  assert.equal(res.status, 200);
  assert.ok(res.text.includes(ABLEHNUNG_ZEITPUNKT), 'expected the response body to include the rejection timestamp');
  db.close();
});

test('POST /abgelehnt/:id/ueberarbeiten reopens the job to zugewiesen and redirects to Kontierung', async () => {
  const db = openDatabase(':memory:');
  const { id, kontoId } = await seedAbgelehntJob(db);
  const app = buildTestApp(db);
  const res = await request(app).post(`/abgelehnt/${id}/ueberarbeiten`).set('x-test-person-id', '1');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, `/kontierung/${id}`);
  const job = getJobById(db, id);
  assert.equal(job.status, 'zugewiesen');
  assert.equal(job.abgelehnt_von, null);
  assert.equal(job.ablehnungsgrund, null);
  assert.equal(job.konto_id, kontoId);
  db.close();
});

test('POST /abgelehnt/:id/ueberarbeiten returns 403 for a person other than zugewiesen_an', async () => {
  const db = openDatabase(':memory:');
  const { id } = await seedAbgelehntJob(db);
  const app = buildTestApp(db);
  const res = await request(app).post(`/abgelehnt/${id}/ueberarbeiten`).set('x-test-person-id', '2');
  assert.equal(res.status, 403);
  assert.equal(getJobById(db, id).status, 'abgelehnt');
  db.close();
});

test('GET /abgelehnt/:id returns 401 without a session', async () => {
  const db = openDatabase(':memory:');
  const { id } = await seedAbgelehntJob(db);
  const app = buildTestApp(db);
  const res = await request(app).get(`/abgelehnt/${id}`);
  assert.equal(res.status, 401);
  db.close();
});
