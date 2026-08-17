import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createKonto, getKontoById } from '../../src/db/kontenRepo.js';
import { createJob, claimJob, getJobById, setKontierung, eskalierenFreigabe1, eskalierenFreigabe2, ablehnenJob, wiederOeffnenJob, listSplitKinder, updateKontierungMetadaten } from '../../src/db/jobsRepo.js';
import { listFreigabenByJob, createFreigabe } from '../../src/db/freigabenRepo.js';
import { loadCurrentPerson, requireLogin } from '../../src/middleware/roles.js';
import { createKontierungRouter } from '../../src/routes/kontierung.js';
import { createApp } from '../../src/app.js';
import { setupMockChurchTools } from '../helpers/mockChurchTools.js';

function createStubMailer() {
  const sent = [];
  return { sent, async sendMail(mail) { sent.push(mail); } };
}

// Full-app helpers (matching freigabeWorkflowEndToEnd.test.js conventions) — used by the SYNC-8
// tests below, which need the real /auth login flow so a Portal-Admin (verified via group
// membership inside the route's own per-job authorization) can reach an admin-escalated job.
// Deliberately omits publicBaseUrl: app.js derives the session cookie's Secure flag from it, and
// express-session refuses to ever send Set-Cookie for a Secure cookie over the plain-HTTP
// requests supertest makes, which would break the /auth/login + /auth/callback flow entirely.
function testConfig() {
  return {
    sessionSecret: 'test-secret',
    env: 'test',
    churchtools: {
      baseUrl: 'https://ct.example.org',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri: 'https://portal.example.org/auth/callback',
      groupIdBuchhaltung: '10',
      groupIdAdmin: '20',
      syncServiceToken: 'token',
    },
    cronSecret: 'cron-secret',
    n8nApiKey: 'n8n-key',
    smtp: { host: 'smtp.example.org', port: 587, user: 'user', pass: 'pass', from: 'portal@example.org' },
    downloadSigningSecret: 'download-secret',
  };
}

async function loginAs(app, client, { id, vorname, nachname, email, gruppen }) {
  client.intercept({ path: '/oauth/access_token', method: 'POST' }).reply(200, { access_token: `tok-${id}` });
  client.intercept({ path: '/oauth/userinfo', method: 'GET' }).reply(200, { id, firstName: vorname, lastName: nachname, email });
  client
    .intercept({ path: '/api/groups/10/members', method: 'GET' })
    .reply(200, { data: gruppen.includes('10') ? [{ personId: id }] : [] });
  client
    .intercept({ path: '/api/groups/20/members', method: 'GET' })
    .reply(200, { data: gruppen.includes('20') ? [{ personId: id }] : [] });

  const agent = request.agent(app);
  const loginRes = await agent.get('/auth/login');
  const state = new URL(loginRes.headers.location).searchParams.get('state');
  const callbackRes = await agent.get('/auth/callback').query({ code: `code-${id}`, state });
  assert.equal(callbackRes.status, 302, `login for person ${id} should succeed`);
  return agent;
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
  app.use('/kontierung', requireLogin(), createKontierungRouter({ db, config, mailer }));
  return app;
}

function seedKontoAndPersonen(db) {
  for (const id of ['1', '2', '3', '4']) {
    upsertPerson(db, { id, vorname: `Person${id}`, nachname: 'Muster', email: `p${id}@example.org`, gruppen: ['10'], loggedInNow: true });
  }
  return createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
}

function buildTestAppMitDateien(db, mailer, jobsDir) {
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
  const config = {
    churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20' },
    downloadSigningSecret: 'test-secret',
    publicBaseUrl: 'https://portal.example.org',
    jobsDir,
  };
  app.use(loadCurrentPerson(db));
  app.use('/kontierung', requireLogin(), createKontierungRouter({ db, config, mailer }));
  return app;
}

test('GET /kontierung/:id is reachable for the assigned person with no group membership at all', async () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'Frei', nachname: 'Geber', email: 'frei@example.org', gruppen: [], loggedInNow: true });
  for (const id of ['2', '3', '4']) {
    upsertPerson(db, { id, vorname: `Person${id}`, nachname: 'Muster', email: `p${id}@example.org`, gruppen: ['10'], loggedInNow: true });
  }
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  const id = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, id, '1');
  const app = buildTestApp(db, createStubMailer());
  const res = await request(app).get(`/kontierung/${id}`).set('x-test-person-id', '1');
  assert.equal(res.status, 200);
  db.close();
});

test('GET /kontierung/:id embeds the preview through the PDF.js viewer, not a raw /downloads iframe', async () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'Frei', nachname: 'Geber', email: 'frei@example.org', gruppen: [], loggedInNow: true });
  for (const id of ['2', '3', '4']) {
    upsertPerson(db, { id, vorname: `Person${id}`, nachname: 'Muster', email: `p${id}@example.org`, gruppen: ['10'], loggedInNow: true });
  }
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  const id = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, id, '1');
  const app = buildTestApp(db, createStubMailer());
  const res = await request(app).get(`/kontierung/${id}`).set('x-test-person-id', '1');
  assert.equal(res.status, 200);
  assert.match(res.text, /id="kontierung-preview-frame" data-preview-url="\/downloads\/\d+\?expires=\d+&amp;signature=[0-9a-f]{64}"/);
  assert.match(res.text, /'\/vendor\/pdfjs\/web\/viewer\.html\?file=' \+ encodeURIComponent\(absoluteUrl\)/);
  assert.match(res.text, /id="preview-refresh-btn"/);
  assert.match(res.text, new RegExp(`/downloads/${id}/refresh-url`));
  db.close();
});

test('GET /kontierung/:id drops the Konto select\'s required attribute on click of Ablehnen, so the browser does not block that submission', async () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'Frei', nachname: 'Geber', email: 'frei@example.org', gruppen: [], loggedInNow: true });
  for (const id of ['2', '3', '4']) {
    upsertPerson(db, { id, vorname: `Person${id}`, nachname: 'Muster', email: `p${id}@example.org`, gruppen: ['10'], loggedInNow: true });
  }
  createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  const id = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, id, '1');
  const app = buildTestApp(db, createStubMailer());
  const res = await request(app).get(`/kontierung/${id}`).set('x-test-person-id', '1');
  assert.equal(res.status, 200);
  assert.match(res.text, /<select class="form-select" id="kontoId" name="kontoId" required>/);
  assert.match(res.text, /<button type="submit" form="kontierung-form" name="aktion" value="ablehnen" id="ablehnen-btn"/);
  assert.match(res.text, /getElementById\('ablehnen-btn'\)\.addEventListener\('click', function \(\) \{\s*document\.getElementById\('kontoId'\)\.required = false;/);
  db.close();
});

test('GET /kontierung/:id shows the quelle and absender that n8n submitted with the job', async () => {
  const db = openDatabase(':memory:');
  seedKontoAndPersonen(db);
  const id = createJob(db, {
    eingangAm: '2026-08-15T08:00:00.000Z',
    quelle: 'lieferant',
    absender: 'buchhaltung@lieferant.example',
    dateiname: 'a.pdf',
    pdfPfad: '/tmp/a.pdf',
  });
  claimJob(db, id, '1');
  const app = buildTestApp(db, createStubMailer());
  const res = await request(app).get(`/kontierung/${id}`).set('x-test-person-id', '1');
  assert.equal(res.status, 200);
  assert.match(res.text, /Lieferant/);
  assert.match(res.text, /buchhaltung@lieferant\.example/);
  db.close();
});

test('GET /kontierung/:id shows an Audit-Log with the prior Freigabe 1 and Ablehnung history after Überarbeiten', async () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKontoAndPersonen(db);
  const id = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  setKontierung(db, id, kontoId);
  createFreigabe(db, { jobId: id, personId: '1', rolle: 'freigeber1', zeitpunkt: '2026-08-15T09:00:00.000Z', ip: '1.2.3.4', interessenskonflikt: false, kommentar: null, eskaliertVon: null });
  db.prepare("UPDATE jobs SET status = 'freigabe2', zugewiesen_an = '1' WHERE id = ?").run(id);
  ablehnenJob(db, id, { abgelehntVon: '3', grund: 'Falsches Konto' });
  createFreigabe(db, { jobId: id, personId: '3', rolle: 'ablehnung', zeitpunkt: '2026-08-15T10:00:00.000Z', ip: '5.6.7.8', interessenskonflikt: false, kommentar: 'Falsches Konto', eskaliertVon: null });
  wiederOeffnenJob(db, id, '1');
  const app = buildTestApp(db, createStubMailer());
  const res = await request(app).get(`/kontierung/${id}`).set('x-test-person-id', '1');
  assert.equal(res.status, 200);
  assert.match(res.text, /Audit-Log/);
  assert.match(res.text, /Freigabe 1 erteilt/);
  assert.match(res.text, /Abgelehnt/);
  db.close();
});

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

test('POST /kontierung/:id without a conflict still saves an optional Begründung as the Freigabe-1 Kommentar', async () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKontoAndPersonen(db);
  const id = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, id, '1');
  const app = buildTestApp(db, createStubMailer());

  const res = await request(app)
    .post(`/kontierung/${id}`)
    .set('x-test-person-id', '1')
    .type('form')
    .send({ kontoId: String(kontoId), interessenskonflikt: 'nein', begruendung: 'Rechnung geprüft, alles korrekt.' });

  assert.equal(res.status, 302);
  const freigaben = listFreigabenByJob(db, id);
  assert.equal(freigaben[0].kommentar, 'Rechnung geprüft, alles korrekt.');
  db.close();
});

test('POST /kontierung/:id persists an edited absender plus betrag, zahlungsziel, rechnungsnummer and the selected Debitor as lieferant', async () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKontoAndPersonen(db);
  const { createDebitor } = await import('../../src/db/debitorenRepo.js');
  const debitorId = createDebitor(db, { name: 'Muster AG', kontoId: null });
  const id = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'lieferant', absender: 'alt@example.org', dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, id, '1');
  const app = buildTestApp(db, createStubMailer());

  const res = await request(app)
    .post(`/kontierung/${id}`)
    .set('x-test-person-id', '1')
    .type('form')
    .send({
      kontoId: String(kontoId),
      interessenskonflikt: 'nein',
      begruendung: '',
      absender: 'neu@example.org',
      betrag: '123,45',
      zahlungsziel: '2026-09-01',
      rechnungsnummer: 'RE-2026-042',
      debitorId: String(debitorId),
    });

  assert.equal(res.status, 302);
  const job = getJobById(db, id);
  assert.equal(job.absender, 'neu@example.org');
  assert.equal(job.betrag, '123.45', 'a comma decimal separator should be normalized to a dot');
  assert.equal(job.zahlungsziel, '2026-09-01');
  assert.equal(job.rechnungsnummer, 'RE-2026-042');
  assert.equal(job.lieferant, 'Muster AG');
  assert.equal(job.debitor_id, debitorId);
  db.close();
});

test('POST /kontierung/:id rejects an invalid betrag, nothing persisted', async () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKontoAndPersonen(db);
  const id = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, id, '1');
  const app = buildTestApp(db, createStubMailer());

  const res = await request(app)
    .post(`/kontierung/${id}`)
    .set('x-test-person-id', '1')
    .type('form')
    .send({ kontoId: String(kontoId), interessenskonflikt: 'nein', begruendung: '', betrag: 'nicht-eine-zahl' });

  assert.equal(res.status, 400);
  assert.match(res.text, /Betrag muss eine gültige Zahl sein/);
  const job = getJobById(db, id);
  assert.equal(job.status, 'zugewiesen');
  assert.equal(job.betrag, null);
  db.close();
});

test('POST /kontierung/:id rejects an invalid zahlungsziel, nothing persisted', async () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKontoAndPersonen(db);
  const id = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, id, '1');
  const app = buildTestApp(db, createStubMailer());

  const res = await request(app)
    .post(`/kontierung/${id}`)
    .set('x-test-person-id', '1')
    .type('form')
    .send({ kontoId: String(kontoId), interessenskonflikt: 'nein', begruendung: '', zahlungsziel: 'nicht-ein-datum' });

  assert.equal(res.status, 400);
  assert.match(res.text, /Zahlungsziel ist kein gültiges Datum/);
  const job = getJobById(db, id);
  assert.equal(job.status, 'zugewiesen');
  assert.equal(job.zahlungsziel, null);
  db.close();
});

test('POST /kontierung/:id aktion=ablehnen rejects the job directly from the Kontierung stage, no Konto needed', async () => {
  const db = openDatabase(':memory:');
  seedKontoAndPersonen(db);
  const id = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, id, '1');
  const app = buildTestApp(db, createStubMailer());

  const res = await request(app)
    .post(`/kontierung/${id}`)
    .set('x-test-person-id', '1')
    .type('form')
    .send({ aktion: 'ablehnen', begruendung: 'Duplikat, bereits bezahlt' });

  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/pool');
  const job = getJobById(db, id);
  assert.equal(job.status, 'abgelehnt');
  assert.equal(job.abgelehnt_von, '1');
  assert.equal(job.ablehnungsgrund, 'Duplikat, bereits bezahlt');
  const freigaben = listFreigabenByJob(db, id);
  assert.equal(freigaben.length, 1);
  assert.equal(freigaben[0].rolle, 'ablehnung');
  db.close();
});

test('POST /kontierung/:id aktion=ablehnen without a Begründung is rejected, job untouched', async () => {
  const db = openDatabase(':memory:');
  seedKontoAndPersonen(db);
  const id = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, id, '1');
  const app = buildTestApp(db, createStubMailer());

  const res = await request(app)
    .post(`/kontierung/${id}`)
    .set('x-test-person-id', '1')
    .type('form')
    .send({ aktion: 'ablehnen', begruendung: '' });

  assert.equal(res.status, 400);
  assert.match(res.text, /Bei einer Ablehnung ist eine Begründung Pflicht/);
  assert.equal(getJobById(db, id).status, 'zugewiesen');
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

test('POST /kontierung/:id from an already-escalated stellvertreter1 declaring another conflict now escalates to Portal-Admin instead of being rejected', async () => {
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

  assert.equal(res.status, 302);
  const job = getJobById(db, id);
  assert.equal(job.freigabe1_eskaliert_an_admin, 1);
  assert.equal(job.status, 'zugewiesen');
  db.close();
});

test('POST /kontierung/:id declaring a conflict while already being the Konto\'s own Stellvertretung now escalates to Portal-Admin instead of self-reassigning', async () => {
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

  assert.equal(res.status, 302);
  const job = getJobById(db, id);
  assert.equal(job.freigabe1_eskaliert_an_admin, 1);
  assert.equal(job.zugewiesen_an, '2', 'must not silently self-reassign the Stellvertretung to themselves; zugewiesen_an is left untouched by the admin-escalation write');
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
  assert.match(mailer.sent[0].text, new RegExp(`/kontierung/${id}`));
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
  assert.match(mailer.sent[0].text, new RegExp(`/freigabe2/${id}`));
  db.close();
});

test('POST /kontierung/:id after a Freigabe-2 conflict + rejection + rework emails the effective stellvertreter2, not the original (recused) freigeber2', async () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKontoAndPersonen(db); // freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4'
  const id = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'rechnung.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, id, '1');

  // Round 1: owner ('1') completes Kontierung without a conflict -> job advances to freigabe2,
  // owner ('1') remains the job's zugewiesen_an for a later rework cycle.
  const setupApp = buildTestApp(db, createStubMailer());
  await request(setupApp)
    .post(`/kontierung/${id}`)
    .set('x-test-person-id', '1')
    .type('form')
    .send({ kontoId: String(kontoId), interessenskonflikt: 'nein', begruendung: '' });

  // Freigeber2 ('3') declares a conflict -> the effective Freigabe-2 approver becomes
  // stellvertreter2 ('4'), recorded via freigabe2_eskaliert_von.
  eskalierenFreigabe2(db, id, { eskaliertVon: '3', grund: 'Befangen' });

  // Stellvertreter2 ('4'), now the effective approver, rejects the job.
  ablehnenJob(db, id, { abgelehntVon: '4', grund: 'Falsches Konto' });

  // Owner ('1') reopens the rejected job for rework. wiederOeffnenJob deliberately does NOT
  // clear freigabe2_eskaliert_von (see jobsRepo.js) -- the conflict is still real after rework.
  wiederOeffnenJob(db, id, '1');
  assert.equal(getJobById(db, id).freigabe2_eskaliert_von, '3', 'sanity: still set after reopening for rework');

  // Owner redoes Kontierung, this time without declaring a conflict. The completion mail must
  // go to the effective approver (stellvertreter2, '4'), not the recused freigeber2 ('3').
  const mailer = createStubMailer();
  const app = buildTestApp(db, mailer);
  const res = await request(app)
    .post(`/kontierung/${id}`)
    .set('x-test-person-id', '1')
    .type('form')
    .send({ kontoId: String(kontoId), interessenskonflikt: 'nein', begruendung: '' });

  assert.equal(res.status, 302);
  assert.equal(mailer.sent.length, 1);
  assert.equal(mailer.sent[0].to, 'p4@example.org', 'must notify the effective stellvertreter2, not the original recused freigeber2');
  db.close();
});

test('a Stellvertreter1 who is escalated to and ALSO has a conflict escalates to Portal-Admin instead of being blocked', async () => {
  // Setup: freigeber1 (person 1) claims a job, picks a konto, declares a conflict -> escalates
  // to stellvertreter1 (person 2). Then person 2 logs in, sees the same job, ALSO declares a
  // conflict -> should now escalate to admin instead of hitting the old dead-end block.
  const config = testConfig();
  const client = setupMockChurchTools(config.churchtools.baseUrl);
  const db = openDatabase(':memory:');
  const { upsertPerson } = await import('../../src/db/personenRepo.js');
  const { createKonto } = await import('../../src/db/kontenRepo.js');
  const { createJob, getJobById } = await import('../../src/db/jobsRepo.js');
  const { listMailLog } = await import('../../src/db/mailLogRepo.js');

  upsertPerson(db, { id: '1', vorname: 'Freigeber', nachname: 'Eins', email: 'f1@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '2', vorname: 'Stellvertreter', nachname: 'Eins', email: 's1@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '3', vorname: 'Freigeber', nachname: 'Zwei', email: 'f2@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '4', vorname: 'Stellvertreter', nachname: 'Zwei', email: 's2@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '99', vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'], loggedInNow: false });
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  const jobId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare("UPDATE jobs SET status = 'zugewiesen', zugewiesen_an = '1' WHERE id = ?").run(jobId);

  const app = createApp({ db, config });
  const freigeber1Agent = await loginAs(app, client, { id: 1, vorname: 'Freigeber', nachname: 'Eins', email: 'f1@example.org', gruppen: ['10'] });
  await freigeber1Agent.post(`/kontierung/${jobId}`).type('form').send({ kontoId: String(kontoId), interessenskonflikt: 'ja', begruendung: 'Ich bin befangen.' });
  assert.equal(getJobById(db, jobId).zugewiesen_an, '2');

  const stellvertreter1Agent = await loginAs(app, client, { id: 2, vorname: 'Stellvertreter', nachname: 'Eins', email: 's1@example.org', gruppen: ['10'] });
  const res = await stellvertreter1Agent
    .post(`/kontierung/${jobId}`)
    .type('form')
    .send({ kontoId: String(kontoId), interessenskonflikt: 'ja', begruendung: 'Ich bin auch befangen.' });

  assert.equal(res.status, 302, 'the second escalation should succeed, not render the form with an error');
  const job = getJobById(db, jobId);
  assert.equal(job.freigabe1_eskaliert_an_admin, 1);
  assert.equal(job.status, 'zugewiesen');

  const adminMails = listMailLog(db).filter((m) => m.typ === 'zuweisung' && m.empfaenger === 'admin@example.org');
  assert.equal(adminMails.length, 1);
  // The notification must link directly to the job, not the generic /pool page — a Portal-Admin
  // clicking through from this email is the only realistic way they discover an escalated job.
  assert.match(adminMails[0].text, new RegExp(`/kontierung/${jobId}(?!\\d)`));
  assert.doesNotMatch(adminMails[0].text, /\/pool/);

  // The (now-excluded) Stellvertreter1 can no longer act on this job...
  const blockedAgent = await loginAs(app, client, { id: 2, vorname: 'Stellvertreter', nachname: 'Eins', email: 's1@example.org', gruppen: ['10'] });
  const blockedRes = await blockedAgent.get(`/kontierung/${jobId}`);
  assert.equal(blockedRes.status, 403);

  // ...but an admin can.
  const adminAgent = await loginAs(app, client, { id: 99, vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'] });
  const adminRes = await adminAgent.get(`/kontierung/${jobId}`);
  assert.equal(adminRes.status, 200);
  db.close();
});

test('a plain, non-conflict resubmission after a prior escalation succeeds normally', async () => {
  const config = testConfig();
  const client = setupMockChurchTools(config.churchtools.baseUrl);
  const db = openDatabase(':memory:');
  const { upsertPerson } = await import('../../src/db/personenRepo.js');
  const { createKonto } = await import('../../src/db/kontenRepo.js');
  const { createJob } = await import('../../src/db/jobsRepo.js');

  upsertPerson(db, { id: '1', vorname: 'Freigeber', nachname: 'Eins', email: 'f1@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '2', vorname: 'Stellvertreter', nachname: 'Eins', email: 's1@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '3', vorname: 'Freigeber', nachname: 'Zwei', email: 'f2@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '4', vorname: 'Stellvertreter', nachname: 'Zwei', email: 's2@example.org', gruppen: ['10'], loggedInNow: false });
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  const jobId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare("UPDATE jobs SET status = 'zugewiesen', zugewiesen_an = '1' WHERE id = ?").run(jobId);

  const app = createApp({ db, config });
  const freigeber1Agent = await loginAs(app, client, { id: 1, vorname: 'Freigeber', nachname: 'Eins', email: 'f1@example.org', gruppen: ['10'] });
  await freigeber1Agent.post(`/kontierung/${jobId}`).type('form').send({ kontoId: String(kontoId), interessenskonflikt: 'ja', begruendung: 'Ich bin befangen.' });

  const stellvertreter1Agent = await loginAs(app, client, { id: 2, vorname: 'Stellvertreter', nachname: 'Eins', email: 's1@example.org', gruppen: ['10'] });
  // No conflict this time, just an ordinary attempt to escalate again (e.g. a stray double
  // form submit) — still needs handling. This drives the branch that used to always error;
  // now it goes through the normal non-conflict completion path since hatKonflikt is false.
  const res = await stellvertreter1Agent
    .post(`/kontierung/${jobId}`)
    .type('form')
    .send({ kontoId: String(kontoId), interessenskonflikt: 'nein', begruendung: '' });
  assert.equal(res.status, 302);
  db.close();
});

test('a person who picks a Konto where they are themselves the stellvertreter1 and declares a conflict escalates straight to admin', async () => {
  const config = testConfig();
  const client = setupMockChurchTools(config.churchtools.baseUrl);
  const db = openDatabase(':memory:');
  const { upsertPerson } = await import('../../src/db/personenRepo.js');
  const { createKonto } = await import('../../src/db/kontenRepo.js');
  const { createJob, getJobById } = await import('../../src/db/jobsRepo.js');

  upsertPerson(db, { id: '1', vorname: 'Freigeber', nachname: 'Eins', email: 'f1@example.org', gruppen: ['10'], loggedInNow: false });
  // Person 2 is stellvertreter1 for THIS konto, but claims the job directly (listKontenForPerson
  // includes konten where they're stellvertreter1 too).
  upsertPerson(db, { id: '2', vorname: 'Stellvertreter', nachname: 'Eins', email: 's1@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '3', vorname: 'Freigeber', nachname: 'Zwei', email: 'f2@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '4', vorname: 'Stellvertreter', nachname: 'Zwei', email: 's2@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '99', vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'], loggedInNow: false });
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  const jobId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare("UPDATE jobs SET status = 'zugewiesen', zugewiesen_an = '2' WHERE id = ?").run(jobId);

  const app = createApp({ db, config });
  const agent = await loginAs(app, client, { id: 2, vorname: 'Stellvertreter', nachname: 'Eins', email: 's1@example.org', gruppen: ['10'] });
  const res = await agent
    .post(`/kontierung/${jobId}`)
    .type('form')
    .send({ kontoId: String(kontoId), interessenskonflikt: 'ja', begruendung: 'Ich bin selbst die Stellvertretung.' });

  assert.equal(res.status, 302, 'this is a first-ever escalation for this job, but self-targeting -> should go straight to admin, not error');
  const job = getJobById(db, jobId);
  assert.equal(job.freigabe1_eskaliert_an_admin, 1);
  db.close();
});

test('a job admin-escalated in Freigabe 1, then rejected in Freigabe 2 and reopened for rework, remains locked to Portal-Admin (conflict-of-interest persists)', async () => {
  const config = testConfig();
  const client = setupMockChurchTools(config.churchtools.baseUrl);
  const db = openDatabase(':memory:');
  const { upsertPerson } = await import('../../src/db/personenRepo.js');
  const { createKonto } = await import('../../src/db/kontenRepo.js');
  const { createJob, getJobById, setKontierung, ablehnenJob, wiederOeffnenJob, abschliessenFreigabe1 } = await import('../../src/db/jobsRepo.js');
  const { createFreigabe } = await import('../../src/db/freigabenRepo.js');

  upsertPerson(db, { id: '1', vorname: 'Freigeber', nachname: 'Eins', email: 'f1@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '2', vorname: 'Stellvertreter', nachname: 'Eins', email: 's1@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '3', vorname: 'Freigeber', nachname: 'Zwei', email: 'f2@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '4', vorname: 'Stellvertreter', nachname: 'Zwei', email: 's2@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '99', vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'], loggedInNow: false });
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  const jobId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  // Person 2 is the Konto's own stellvertreter1, so their first-ever conflict declaration on
  // this Konto escalates straight to admin (the same case covered above).
  db.prepare("UPDATE jobs SET status = 'zugewiesen', zugewiesen_an = '2' WHERE id = ?").run(jobId);

  const app = createApp({ db, config });
  const stellvertreterAgent = await loginAs(app, client, { id: 2, vorname: 'Stellvertreter', nachname: 'Eins', email: 's1@example.org', gruppen: ['10'] });
  await stellvertreterAgent
    .post(`/kontierung/${jobId}`)
    .type('form')
    .send({ kontoId: String(kontoId), interessenskonflikt: 'ja', begruendung: 'Ich bin selbst die Stellvertretung.' });
  const escalatedJob = getJobById(db, jobId);
  assert.equal(escalatedJob.freigabe1_eskaliert_an_admin, 1, 'sanity: escalated to admin');

  // The admin (authorized via the flag branch) completes Freigabe 1 (no further conflict). This
  // reproduces exactly what the router's non-conflict completion branch does; done via direct
  // repo calls here rather than an admin HTTP POST because listKontenForPerson (a separate,
  // pre-existing constraint unrelated to this fix) only returns Konten the caller holds a role
  // on, and a Portal-Admin resolving someone else's conflict generally holds no role on the
  // job's Konto -- not something this task's authorization fix touches.
  setKontierung(db, jobId, kontoId);
  createFreigabe(db, {
    jobId,
    personId: '99',
    rolle: 'freigeber1',
    zeitpunkt: new Date().toISOString(),
    ip: '127.0.0.1',
    interessenskonflikt: false,
    kommentar: null,
    eskaliertVon: escalatedJob.freigabe1_eskaliert_von,
  });
  abschliessenFreigabe1(db, jobId);
  const afterFreigabe1 = getJobById(db, jobId);
  assert.equal(afterFreigabe1.status, 'freigabe2');
  assert.equal(afterFreigabe1.freigabe1_eskaliert_an_admin, 1, 'flag must survive Freigabe 1 completion — the conflict-of-interest belongs to the invoice, not one submission attempt');
  assert.equal(afterFreigabe1.zugewiesen_an, '2', 'zugewiesen_an is untouched throughout the admin-escalation path');

  // Freigabe 2 rejects the job; the owner ('2') reopens it for an unrelated rework cycle.
  ablehnenJob(db, jobId, { abgelehntVon: '3', grund: 'Falsches Konto' });
  wiederOeffnenJob(db, jobId, '2');
  const reopened = getJobById(db, jobId);
  assert.equal(reopened.status, 'zugewiesen');
  assert.equal(reopened.freigabe1_eskaliert_an_admin, 1, 'a fresh rework cycle stays locked to Portal-Admin-only access because the conflict persists');

  // The original owner ('2'), who is not a Portal-Admin, cannot open the job anymore — it is
  // legitimately excluded until a Portal-Admin releases it or the conflict is otherwise resolved.
  const ownerAgent = await loginAs(app, client, { id: 2, vorname: 'Stellvertreter', nachname: 'Eins', email: 's1@example.org', gruppen: ['10'] });
  const ownerRes = await ownerAgent.get(`/kontierung/${jobId}`);
  assert.equal(ownerRes.status, 403, 'owner is no longer authorized; the job is locked to Portal-Admin');
  db.close();
});

test('a Portal-Admin authorized via the freigabe1_eskaliert_an_admin flag can release the job back to the pool', async () => {
  const config = testConfig();
  const client = setupMockChurchTools(config.churchtools.baseUrl);
  const db = openDatabase(':memory:');
  const { upsertPerson } = await import('../../src/db/personenRepo.js');
  const { createKonto } = await import('../../src/db/kontenRepo.js');
  const { createJob, getJobById } = await import('../../src/db/jobsRepo.js');

  upsertPerson(db, { id: '1', vorname: 'Freigeber', nachname: 'Eins', email: 'f1@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '2', vorname: 'Stellvertreter', nachname: 'Eins', email: 's1@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '3', vorname: 'Freigeber', nachname: 'Zwei', email: 'f2@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '4', vorname: 'Stellvertreter', nachname: 'Zwei', email: 's2@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '99', vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'], loggedInNow: false });
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  const jobId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare("UPDATE jobs SET status = 'zugewiesen', zugewiesen_an = '2' WHERE id = ?").run(jobId);

  const app = createApp({ db, config });
  const stellvertreterAgent = await loginAs(app, client, { id: 2, vorname: 'Stellvertreter', nachname: 'Eins', email: 's1@example.org', gruppen: ['10'] });
  await stellvertreterAgent
    .post(`/kontierung/${jobId}`)
    .type('form')
    .send({ kontoId: String(kontoId), interessenskonflikt: 'ja', begruendung: 'Ich bin selbst die Stellvertretung.' });
  assert.equal(getJobById(db, jobId).freigabe1_eskaliert_an_admin, 1, 'sanity: escalated to admin');

  // The admin (not a member of Buchhaltung, authorized only via the flag branch) decides to
  // send the job back to the pool instead of completing it.
  const adminAgent = await loginAs(app, client, { id: 99, vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'] });
  const releaseRes = await adminAgent.post(`/kontierung/${jobId}/zurueck-in-pool`);
  assert.equal(releaseRes.status, 302);
  assert.equal(releaseRes.headers.location, '/pool');

  const job = getJobById(db, jobId);
  assert.equal(job.status, 'unzugewiesen', 'the job must actually be released, not silently no-op');
  assert.equal(job.zugewiesen_an, null);
  assert.equal(job.konto_id, null);
  assert.equal(job.freigabe1_eskaliert_an_admin, 0, 'the admin-only lock must not survive back into the pool for the next claimer');
  db.close();
});

test('a Portal-Admin with zero roles on the job\'s Konto can still complete Kontierung through the real form for a self-escalated job', async () => {
  // Case B (self-escalation): the job's own Konto's stellvertreter1 IS the person who claims and
  // Kontiert the job, so it escalates straight to admin. The admin who then gets authorized via
  // loadAuthorizedJob's flag branch holds, BY DEFINITION, no freigeber1/stellvertreter1 role on
  // that Konto -- listKontenForPerson alone would return an empty list for them, making the
  // Konto dropdown unselectable and the POST handler's konten.find(...) always fail. This proves
  // ladeKontenFuerJob's fix (appending the job's already-assigned Konto) makes the admin's own
  // real HTTP resubmission actually succeed.
  const config = testConfig();
  const client = setupMockChurchTools(config.churchtools.baseUrl);
  const db = openDatabase(':memory:');
  const { upsertPerson } = await import('../../src/db/personenRepo.js');
  const { createKonto } = await import('../../src/db/kontenRepo.js');
  const { createJob, getJobById } = await import('../../src/db/jobsRepo.js');

  upsertPerson(db, { id: '1', vorname: 'Freigeber', nachname: 'Eins', email: 'f1@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '2', vorname: 'Stellvertreter', nachname: 'Eins', email: 's1@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '3', vorname: 'Freigeber', nachname: 'Zwei', email: 'f2@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '4', vorname: 'Stellvertreter', nachname: 'Zwei', email: 's2@example.org', gruppen: ['10'], loggedInNow: false });
  // Admin '99' is a Portal-Admin only -- no group '10' (Buchhaltung) membership, and no
  // freigeber1/stellvertreter1/freigeber2/stellvertreter2 role on the Konto below.
  upsertPerson(db, { id: '99', vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'], loggedInNow: false });
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  const jobId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare("UPDATE jobs SET status = 'zugewiesen', zugewiesen_an = '2' WHERE id = ?").run(jobId);

  const app = createApp({ db, config });
  const stellvertreterAgent = await loginAs(app, client, { id: 2, vorname: 'Stellvertreter', nachname: 'Eins', email: 's1@example.org', gruppen: ['10'] });
  await stellvertreterAgent
    .post(`/kontierung/${jobId}`)
    .type('form')
    .send({ kontoId: String(kontoId), interessenskonflikt: 'ja', begruendung: 'Ich bin selbst die Stellvertretung.' });
  const escalated = getJobById(db, jobId);
  assert.equal(escalated.freigabe1_eskaliert_an_admin, 1, 'sanity: escalated to admin');
  assert.equal(escalated.konto_id, kontoId, 'sanity: the job already carries the Konto the admin must resubmit');

  const adminAgent = await loginAs(app, client, { id: 99, vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'] });

  // Confirm the dropdown actually offers the Konto (not just that GET returns 200).
  const getRes = await adminAgent.get(`/kontierung/${jobId}`);
  assert.equal(getRes.status, 200);
  assert.match(getRes.text, /3000/, 'the admin must be able to see/select the job\'s own Konto despite holding no role on it');

  const postRes = await adminAgent
    .post(`/kontierung/${jobId}`)
    .type('form')
    .send({ kontoId: String(kontoId), interessenskonflikt: 'nein', begruendung: '' });

  assert.equal(postRes.status, 302, 'the admin must be able to actually submit the form, not just view it');
  const job = getJobById(db, jobId);
  assert.equal(job.status, 'freigabe2', 'Freigabe 1 must actually complete, not just redirect');
  assert.equal(job.konto_id, kontoId);
  db.close();
});

function seedJobMitDateien(db, jobsDir, { betrag = '200.00' } = {}) {
  const kontoId = seedKontoAndPersonen(db);
  const pdfPfad = join(jobsDir, `original-${Date.now()}.pdf`);
  writeFileSync(pdfPfad, '%PDF-1.4\n%test\n');
  const id = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'lieferant', absender: 'lief@example.org', dateiname: 'rechnung.pdf', pdfPfad });
  claimJob(db, id, '1');
  updateKontierungMetadaten(db, id, { absender: 'lief@example.org', betrag, zahlungsziel: '2026-09-01', rechnungsnummer: 'RE-1', lieferant: 'Muster AG', debitorId: null });
  return { id, kontoId, pdfPfad };
}

test('GET /kontierung/:id/aufsplitten works even when the job has no Betrag yet, with an empty Gesamtbetrag field to fill in', async () => {
  const db = openDatabase(':memory:');
  const jobsDir = mkdtempSync(join(tmpdir(), 'split-test-'));
  seedKontoAndPersonen(db);
  const id = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, id, '1');
  const app = buildTestAppMitDateien(db, createStubMailer(), jobsDir);

  const res = await request(app).get(`/kontierung/${id}/aufsplitten`).set('x-test-person-id', '1');
  assert.equal(res.status, 200);
  assert.match(res.text, /name="gesamtbetrag"/);
  assert.match(res.text, /id="gesamtbetrag"[^>]*value=""/);
  db.close();
  rmSync(jobsDir, { recursive: true, force: true });
});

test('GET /kontierung/:id/aufsplitten pre-fills Gesamtbetrag from the job when one is already set', async () => {
  const db = openDatabase(':memory:');
  const jobsDir = mkdtempSync(join(tmpdir(), 'split-test-'));
  const { id } = seedJobMitDateien(db, jobsDir, { betrag: '200.00' });
  const app = buildTestAppMitDateien(db, createStubMailer(), jobsDir);

  const res = await request(app).get(`/kontierung/${id}/aufsplitten`).set('x-test-person-id', '1');
  assert.equal(res.status, 200);
  assert.match(res.text, /name="teilKontoId"/);
  assert.match(res.text, /name="teilBetrag"/);
  assert.match(res.text, /id="gesamtbetrag"[^>]*value="200\.00"/);
  db.close();
  rmSync(jobsDir, { recursive: true, force: true });
});

test('POST /kontierung/:id/aufsplitten creates independent split jobs, each with its own file, Freigabe 1 already granted, marks the parent aufgesplittet', async () => {
  const db = openDatabase(':memory:');
  const jobsDir = mkdtempSync(join(tmpdir(), 'split-test-'));
  const { id, kontoId, pdfPfad } = seedJobMitDateien(db, jobsDir, { betrag: '200.00' });
  const app = buildTestAppMitDateien(db, createStubMailer(), jobsDir);

  const res = await request(app)
    .post(`/kontierung/${id}/aufsplitten`)
    .set('x-test-person-id', '1')
    .type('form')
    .send({
      gesamtbetrag: '200.00',
      teilKontoId: [String(kontoId), String(kontoId)],
      teilBetrag: ['120.00', '80.00'],
    });

  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/pool');

  const parent = getJobById(db, id);
  assert.equal(parent.status, 'aufgesplittet');
  assert.ok(existsSync(pdfPfad), 'the parent PDF must survive — children get their own copies');

  const kinder = listSplitKinder(db, id);
  assert.equal(kinder.length, 2);
  const betraege = kinder.map((k) => k.betrag).sort();
  assert.deepEqual(betraege, ['120.00', '80.00'].sort());
  for (const kind of kinder) {
    assert.equal(kind.status, 'freigabe2', 'Freigabe 1 should already be granted for each split part');
    assert.equal(kind.konto_id, kontoId);
    assert.equal(kind.zahlungsziel, '2026-09-01');
    assert.equal(kind.lieferant, 'Muster AG');
    assert.equal(kind.rechnungsnummer, 'RE-1');
    assert.equal(kind.aufgesplittet_von, id);
    assert.notEqual(kind.pdf_pfad, pdfPfad, 'each split part must own its own copy of the PDF, not share the parent\'s');
    assert.ok(existsSync(kind.pdf_pfad));
    const freigaben = listFreigabenByJob(db, kind.id);
    assert.equal(freigaben.length, 1);
    assert.equal(freigaben[0].rolle, 'freigeber1');
    assert.equal(freigaben[0].person_id, '1');
  }
  db.close();
  rmSync(jobsDir, { recursive: true, force: true });
});

test('POST /kontierung/:id/aufsplitten rejects Teilbeträge that do not sum to the original Betrag, nothing persisted', async () => {
  const db = openDatabase(':memory:');
  const jobsDir = mkdtempSync(join(tmpdir(), 'split-test-'));
  const { id, kontoId } = seedJobMitDateien(db, jobsDir, { betrag: '200.00' });
  const app = buildTestAppMitDateien(db, createStubMailer(), jobsDir);

  const res = await request(app)
    .post(`/kontierung/${id}/aufsplitten`)
    .set('x-test-person-id', '1')
    .type('form')
    .send({
      gesamtbetrag: '200.00',
      teilKontoId: [String(kontoId), String(kontoId)],
      teilBetrag: ['120.00', '90.00'],
    });

  assert.equal(res.status, 400);
  assert.match(res.text, /Summe der Teilbeträge/);
  assert.equal(getJobById(db, id).status, 'zugewiesen');
  assert.equal(listSplitKinder(db, id).length, 0);
  db.close();
  rmSync(jobsDir, { recursive: true, force: true });
});

test('POST /kontierung/:id/aufsplitten rejects a missing or invalid Gesamtbetrag, nothing persisted', async () => {
  const db = openDatabase(':memory:');
  const jobsDir = mkdtempSync(join(tmpdir(), 'split-test-'));
  const { id, kontoId } = seedJobMitDateien(db, jobsDir, { betrag: '200.00' });
  const app = buildTestAppMitDateien(db, createStubMailer(), jobsDir);

  const res = await request(app)
    .post(`/kontierung/${id}/aufsplitten`)
    .set('x-test-person-id', '1')
    .type('form')
    .send({
      gesamtbetrag: '',
      teilKontoId: [String(kontoId), String(kontoId)],
      teilBetrag: ['120.00', '80.00'],
    });

  assert.equal(res.status, 400);
  assert.match(res.text, /gültigen Gesamtbetrag/);
  assert.equal(getJobById(db, id).status, 'zugewiesen');
  assert.equal(listSplitKinder(db, id).length, 0);
  db.close();
  rmSync(jobsDir, { recursive: true, force: true });
});

test('POST /kontierung/:id/aufsplitten succeeds for a job that never had a Betrag saved — the Gesamtbetrag field on the split page itself is enough, no prior save step needed', async () => {
  const db = openDatabase(':memory:');
  const jobsDir = mkdtempSync(join(tmpdir(), 'split-test-'));
  const kontoId = seedKontoAndPersonen(db);
  const pdfPfad = join(jobsDir, `original-${Date.now()}.pdf`);
  writeFileSync(pdfPfad, '%PDF-1.4\n%test\n');
  const id = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'lieferant', absender: 'lief@example.org', dateiname: 'rechnung.pdf', pdfPfad });
  claimJob(db, id, '1');
  assert.equal(getJobById(db, id).betrag, null, 'sanity check: no Betrag has ever been saved for this job');
  const app = buildTestAppMitDateien(db, createStubMailer(), jobsDir);

  const res = await request(app)
    .post(`/kontierung/${id}/aufsplitten`)
    .set('x-test-person-id', '1')
    .type('form')
    .send({
      gesamtbetrag: '150.00',
      teilKontoId: [String(kontoId), String(kontoId)],
      teilBetrag: ['100.00', '50.00'],
    });

  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/pool');
  const parent = getJobById(db, id);
  assert.equal(parent.status, 'aufgesplittet');
  assert.equal(parent.betrag, '150.00', 'the Gesamtbetrag entered on the split page should be saved onto the parent too');
  assert.equal(listSplitKinder(db, id).length, 2);
  db.close();
  rmSync(jobsDir, { recursive: true, force: true });
});

test('POST /kontierung/:id/aufsplitten rejects fewer than two Teilbeträge', async () => {
  const db = openDatabase(':memory:');
  const jobsDir = mkdtempSync(join(tmpdir(), 'split-test-'));
  const { id, kontoId } = seedJobMitDateien(db, jobsDir, { betrag: '200.00' });
  const app = buildTestAppMitDateien(db, createStubMailer(), jobsDir);

  const res = await request(app)
    .post(`/kontierung/${id}/aufsplitten`)
    .set('x-test-person-id', '1')
    .type('form')
    .send({
      gesamtbetrag: '200.00',
      teilKontoId: [String(kontoId)],
      teilBetrag: ['200.00'],
    });

  assert.equal(res.status, 400);
  assert.match(res.text, /Mindestens zwei Teilbeträge/);
  assert.equal(getJobById(db, id).status, 'zugewiesen');
  db.close();
  rmSync(jobsDir, { recursive: true, force: true });
});

test('POST /kontierung/:id/aufsplitten rejects a Konto the person is not authorized on', async () => {
  const db = openDatabase(':memory:');
  const jobsDir = mkdtempSync(join(tmpdir(), 'split-test-'));
  const { id, kontoId } = seedJobMitDateien(db, jobsDir, { betrag: '200.00' });
  upsertPerson(db, { id: '9', vorname: 'Fremd', nachname: 'Person', email: 'fremd@example.org', gruppen: ['10'], loggedInNow: true });
  upsertPerson(db, { id: '10', vorname: 'Fremd2', nachname: 'Person', email: 'fremd2@example.org', gruppen: ['10'], loggedInNow: true });
  const fremdKontoId = createKonto(db, { kontonummer: '9999', bezeichnung: 'Fremdkonto', freigeber1Id: '9', stellvertreter1Id: '10', freigeber2Id: '9', stellvertreter2Id: '10' });
  const app = buildTestAppMitDateien(db, createStubMailer(), jobsDir);

  const res = await request(app)
    .post(`/kontierung/${id}/aufsplitten`)
    .set('x-test-person-id', '1')
    .type('form')
    .send({
      gesamtbetrag: '200.00',
      teilKontoId: [String(kontoId), String(fremdKontoId)],
      teilBetrag: ['100.00', '100.00'],
    });

  assert.equal(res.status, 400);
  assert.match(res.text, /gültiges Konto/);
  assert.equal(getJobById(db, id).status, 'zugewiesen');
  db.close();
  rmSync(jobsDir, { recursive: true, force: true });
});
