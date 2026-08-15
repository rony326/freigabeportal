import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createKonto, getKontoById } from '../../src/db/kontenRepo.js';
import { createJob, claimJob, getJobById, eskalierenFreigabe1 } from '../../src/db/jobsRepo.js';
import { listFreigabenByJob } from '../../src/db/freigabenRepo.js';
import { loadCurrentPerson, requireRole } from '../../src/middleware/roles.js';
import { createKontierungRouter } from '../../src/routes/kontierung.js';

function createStubMailer() {
  const sent = [];
  return { sent, async sendMail(mail) { sent.push(mail); } };
}

function buildTestApp(db, mailer) {
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
  const config = { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20' }, downloadSigningSecret: 'test-secret', publicBaseUrl: 'https://portal.example.org' };
  app.use(loadCurrentPerson(db));
  app.use('/kontierung', requireRole(config, 'buchhaltung'), createKontierungRouter({ db, config, mailer }));
  return app;
}

function seedKontoAndPersonen(db) {
  for (const id of ['1', '2', '3', '4']) {
    upsertPerson(db, { id, vorname: `Person${id}`, nachname: 'Muster', email: `p${id}@example.org`, gruppen: ['10'], loggedInNow: true });
  }
  return createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
}

test('GET /kontierung/:id returns 403 for a person the job is not assigned to', async () => {
  const db = openDatabase(':memory:');
  seedKontoAndPersonen(db);
  const id = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, id, '1');
  const app = buildTestApp(db, createStubMailer());
  const res = await request(app).get(`/kontierung/${id}`).set('x-test-person-id', '2');
  assert.equal(res.status, 403);
  db.close();
});

test('GET /kontierung/:id returns 403 once the job has left status zugewiesen', async () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKontoAndPersonen(db);
  const id = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, id, '1');
  db.prepare("UPDATE jobs SET status = 'freigabe2', konto_id = ? WHERE id = ?").run(kontoId, id);
  const app = buildTestApp(db, createStubMailer());
  const res = await request(app).get(`/kontierung/${id}`).set('x-test-person-id', '1');
  assert.equal(res.status, 403);
  db.close();
});

test('GET /kontierung/:id shows only the assigned person\'s own Konten', async () => {
  const db = openDatabase(':memory:');
  seedKontoAndPersonen(db);
  const id = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, id, '1');
  const app = buildTestApp(db, createStubMailer());
  const res = await request(app).get(`/kontierung/${id}`).set('x-test-person-id', '1');
  assert.equal(res.status, 200);
  assert.match(res.text, /3000/);
  db.close();
});

test('GET /kontierung/:id shows an empty Konto dropdown for a pool-claim by someone with no Konten of their own, and they can release it back to the pool', async () => {
  const db = openDatabase(':memory:');
  seedKontoAndPersonen(db); // Konto 3000 belongs to persons '1'/'2'/'3'/'4' only
  upsertPerson(db, { id: '5', vorname: 'Ohne', nachname: 'Konto', email: 'p5@example.org', gruppen: ['10'], loggedInNow: true });
  const id = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, id, '5');
  const app = buildTestApp(db, createStubMailer());

  const getRes = await request(app).get(`/kontierung/${id}`).set('x-test-person-id', '5');
  assert.equal(getRes.status, 200);
  assert.doesNotMatch(getRes.text, /3000/, 'person 5 has no role on Konto 3000, so it must not appear in their dropdown');

  const releaseRes = await request(app).post(`/kontierung/${id}/zurueck-in-pool`).set('x-test-person-id', '5');
  assert.equal(releaseRes.status, 302);
  assert.equal(releaseRes.headers.location, '/pool');
  assert.equal(getJobById(db, id).status, 'unzugewiesen');
  db.close();
});

test('POST /kontierung/:id without a conflict creates the Freigabe-1 row and advances status to freigabe2', async () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKontoAndPersonen(db);
  const id = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, id, '1');
  const app = buildTestApp(db, createStubMailer());

  const res = await request(app)
    .post(`/kontierung/${id}`)
    .set('x-test-person-id', '1')
    .type('form')
    .send({ kontoId: String(kontoId), interessenskonflikt: 'nein', begruendung: '' });

  assert.equal(res.status, 302);
  const job = getJobById(db, id);
  assert.equal(job.status, 'freigabe2');
  assert.equal(job.konto_id, kontoId);
  const freigaben = listFreigabenByJob(db, id);
  assert.equal(freigaben.length, 1);
  assert.equal(freigaben[0].rolle, 'freigeber1');
  assert.equal(freigaben[0].person_id, '1');
  assert.equal(freigaben[0].interessenskonflikt, 0);
  db.close();
});

test('POST /kontierung/:id with a conflict reassigns to stellvertreter1, creates no Freigabe row', async () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKontoAndPersonen(db);
  const id = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, id, '1');
  const app = buildTestApp(db, createStubMailer());

  const res = await request(app)
    .post(`/kontierung/${id}`)
    .set('x-test-person-id', '1')
    .type('form')
    .send({ kontoId: String(kontoId), interessenskonflikt: 'ja', begruendung: 'Befangen' });

  assert.equal(res.status, 302);
  const job = getJobById(db, id);
  assert.equal(job.status, 'zugewiesen');
  assert.equal(job.konto_id, kontoId);
  assert.equal(job.zugewiesen_an, '2');
  assert.equal(job.freigabe1_eskaliert_von, '1');
  assert.equal(job.freigabe1_eskalationsgrund, 'Befangen');
  assert.equal(listFreigabenByJob(db, id).length, 0);
  db.close();
});

test('POST /kontierung/:id from an already-escalated stellvertreter1 declaring another conflict is rejected, not re-escalated to self', async () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKontoAndPersonen(db);
  const id = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, id, '1');
  eskalierenFreigabe1(db, id, { eskaliertVon: '1', grund: 'Erster Konflikt', stellvertreterId: '2' });
  const app = buildTestApp(db, createStubMailer());

  const res = await request(app)
    .post(`/kontierung/${id}`)
    .set('x-test-person-id', '2')
    .type('form')
    .send({ kontoId: String(kontoId), interessenskonflikt: 'ja', begruendung: 'Zweiter Konflikt' });

  assert.equal(res.status, 400);
  const job = getJobById(db, id);
  assert.equal(job.freigabe1_eskaliert_von, '1');
  assert.equal(job.status, 'zugewiesen');
  db.close();
});

test('POST /kontierung/:id declaring a conflict while already being the Konto\'s own Stellvertretung is rejected, not self-reassigned', async () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKontoAndPersonen(db); // freigeber1Id: '1', stellvertreter1Id: '2'
  const id = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  // Represents the post-rework state: person '2' (the Konto's own stellvertreter1) is now the
  // current owner of this cycle's job, e.g. after reopening a rejected job they reworked.
  claimJob(db, id, '2');
  const app = buildTestApp(db, createStubMailer());

  const res = await request(app)
    .post(`/kontierung/${id}`)
    .set('x-test-person-id', '2')
    .type('form')
    .send({ kontoId: String(kontoId), interessenskonflikt: 'ja', begruendung: 'Befangen' });

  assert.equal(res.status, 400);
  const job = getJobById(db, id);
  assert.equal(job.zugewiesen_an, '2', 'must not silently self-reassign the Stellvertretung to themselves');
  db.close();
});

test('POST /kontierung/:id with a conflict but no Begründung is rejected, nothing persisted', async () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKontoAndPersonen(db);
  const id = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, id, '1');
  const app = buildTestApp(db, createStubMailer());

  const res = await request(app)
    .post(`/kontierung/${id}`)
    .set('x-test-person-id', '1')
    .type('form')
    .send({ kontoId: String(kontoId), interessenskonflikt: 'ja', begruendung: '' });

  assert.equal(res.status, 400);
  const job = getJobById(db, id);
  assert.equal(job.status, 'zugewiesen');
  assert.equal(job.konto_id, null);
  db.close();
});

test('POST /kontierung/:id with a Konto the person has no role on is rejected, nothing persisted', async () => {
  const db = openDatabase(':memory:');
  seedKontoAndPersonen(db);
  const anderesKontoId = createKonto(db, { kontonummer: '9999', bezeichnung: 'Fremd', freigeber1Id: '3', stellvertreter1Id: '4', freigeber2Id: '1', stellvertreter2Id: '2' });
  const id = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, id, '1');
  const app = buildTestApp(db, createStubMailer());

  const res = await request(app)
    .post(`/kontierung/${id}`)
    .set('x-test-person-id', '1')
    .type('form')
    .send({ kontoId: String(anderesKontoId), interessenskonflikt: 'nein', begruendung: '' });

  assert.equal(res.status, 400);
  assert.equal(getJobById(db, id).konto_id, null);
  db.close();
});

test('POST /kontierung/:id/zurueck-in-pool releases the job and redirects to /pool', async () => {
  const db = openDatabase(':memory:');
  seedKontoAndPersonen(db);
  const id = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, id, '1');
  const app = buildTestApp(db, createStubMailer());

  const res = await request(app).post(`/kontierung/${id}/zurueck-in-pool`).set('x-test-person-id', '1');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/pool');
  const job = getJobById(db, id);
  assert.equal(job.status, 'unzugewiesen');
  assert.equal(job.zugewiesen_an, null);
  db.close();
});

test('POST /kontierung/:id/zurueck-in-pool returns 403 for a person the job is not assigned to', async () => {
  const db = openDatabase(':memory:');
  seedKontoAndPersonen(db);
  const id = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, id, '1');
  const app = buildTestApp(db, createStubMailer());

  const res = await request(app).post(`/kontierung/${id}/zurueck-in-pool`).set('x-test-person-id', '2');
  assert.equal(res.status, 403);
  assert.equal(getJobById(db, id).status, 'zugewiesen');
  db.close();
});

test('POST /kontierung/:id with a conflict sends a Zuweisungs-Mail to stellvertreter1', async () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKontoAndPersonen(db); // freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4'
  const id = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'rechnung.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, id, '1');
  const mailer = createStubMailer();
  const app = buildTestApp(db, mailer);

  const res = await request(app)
    .post(`/kontierung/${id}`)
    .set('x-test-person-id', '1')
    .type('form')
    .send({ kontoId: String(kontoId), interessenskonflikt: 'ja', begruendung: 'Befangen' });

  assert.equal(res.status, 302);
  assert.equal(mailer.sent.length, 1);
  assert.equal(mailer.sent[0].to, 'p2@example.org');
  assert.match(mailer.sent[0].text, /rechnung\.pdf/);
  db.close();
});

test('POST /kontierung/:id without a conflict sends a Zuweisungs-Mail to freigeber2', async () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKontoAndPersonen(db);
  const id = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'rechnung.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, id, '1');
  const mailer = createStubMailer();
  const app = buildTestApp(db, mailer);

  const res = await request(app)
    .post(`/kontierung/${id}`)
    .set('x-test-person-id', '1')
    .type('form')
    .send({ kontoId: String(kontoId), interessenskonflikt: 'nein', begruendung: '' });

  assert.equal(res.status, 302);
  assert.equal(mailer.sent.length, 1);
  assert.equal(mailer.sent[0].to, 'p3@example.org');
  db.close();
});
