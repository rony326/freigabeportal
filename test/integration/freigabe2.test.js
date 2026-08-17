import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { readFileSync, writeFileSync } from 'node:fs';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson, getPersonById } from '../../src/db/personenRepo.js';
import { createKonto } from '../../src/db/kontenRepo.js';
import { createJob, setKontierung, getJobById, eskalierenFreigabe2, ablehnenJob } from '../../src/db/jobsRepo.js';
import { createFreigabe, listFreigabenByJob } from '../../src/db/freigabenRepo.js';
import { loadCurrentPerson, requireLogin } from '../../src/middleware/roles.js';
import { createFreigabe2Router } from '../../src/routes/freigabe2.js';
import { buildPdfFixture } from '../helpers/pdfFixture.js';
import * as mupdf from 'mupdf';
import { createApp } from '../../src/app.js';
import { setupMockChurchTools } from '../helpers/mockChurchTools.js';

function createStubMailer() {
  const sent = [];
  return { sent, async sendMail(mail) { sent.push(mail); } };
}

// Full-app helpers (matching kontierung.test.js conventions) — used by the SYNC-8 test below,
// which needs the real /auth login flow so a Portal-Admin (verified via group
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

function buildTestApp(db, { withErrorHandler = false, mailer } = {}) {
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
  app.use('/freigabe2', requireLogin(), createFreigabe2Router({ db, config, mailer }));
  if (withErrorHandler) {
    // Mirrors src/app.js's generic error middleware: anything reaching next(err) gets a
    // German 500 page instead of crashing the process.
    app.use((err, req, res, next) => {
      res.status(500).render('error', { message: 'Es ist ein unerwarteter Fehler aufgetreten. Bitte versuche es später erneut.' });
    });
  }
  return app;
}

async function seedFreigabe2Job(db, { pdfPfad }) {
  for (const id of ['1', '2', '3', '4']) {
    upsertPerson(db, { id, vorname: `Person${id}`, nachname: 'Muster', email: `p${id}@example.org`, gruppen: ['10'], loggedInNow: true });
  }
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  const id = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad });
  setKontierung(db, id, kontoId);
  createFreigabe(db, { jobId: id, personId: '1', rolle: 'freigeber1', zeitpunkt: '2026-08-15T08:30:00.000Z', ip: '1.2.3.4', interessenskonflikt: false, kommentar: null, eskaliertVon: null });
  // zugewiesen_an mirrors what claimJob + Kontierung leave behind in the real flow (the owner
  // who submitted Kontierung stays the job's owner through Freigabe 2, per kontierung.js /
  // ablehnung.js's own reliance on this field) — Task 5's Ablehnungs-Benachrichtigung needs it.
  db.prepare("UPDATE jobs SET status = 'freigabe2', zugewiesen_an = '1' WHERE id = ?").run(id);
  return { id, kontoId };
}

async function seedFreigabe2JobMitAdminEskalation(db, { pdfPfad }) {
  for (const id of ['1', '2', '3', '4']) {
    upsertPerson(db, { id, vorname: `Person${id}`, nachname: 'Muster', email: `p${id}@example.org`, gruppen: ['10'], loggedInNow: true });
  }
  upsertPerson(db, { id: '5', vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'], loggedInNow: true });
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  const id = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad });
  setKontierung(db, id, kontoId);
  createFreigabe(db, { jobId: id, personId: '2', rolle: 'freigeber1', zeitpunkt: '2026-08-15T08:30:00.000Z', ip: '1.2.3.4', interessenskonflikt: false, kommentar: null, eskaliertVon: '1' });
  const { eskalierenFreigabe1AnAdmin } = await import('../../src/db/jobsRepo.js');
  eskalierenFreigabe1AnAdmin(db, id, { eskaliertVon: '2', grund: 'Auch befangen' });
  db.prepare("UPDATE jobs SET status = 'freigabe2', zugewiesen_an = '2' WHERE id = ?").run(id);
  return { id, kontoId };
}

test('GET /freigabe2/:id is reachable for the effective freigeber2 with no group membership at all', async () => {
  const db = openDatabase(':memory:');
  const { id } = await seedFreigabe2Job(db, { pdfPfad: '/tmp/a.pdf' });
  upsertPerson(db, { id: '3', vorname: 'Person3', nachname: 'Muster', email: 'p3@example.org', gruppen: [], loggedInNow: true });
  const app = buildTestApp(db);
  const res = await request(app).get(`/freigabe2/${id}`).set('x-test-person-id', '3');
  assert.equal(res.status, 200);
  db.close();
});

test('GET and POST /freigabe2/:id reject the person who already approved Freigabe 1 on this job, even if the Konto is edited to resolve them as Freigabe-2 approver (Vier-Augen-Prinzip)', async () => {
  const { updateKonto } = await import('../../src/db/kontenRepo.js');
  const db = openDatabase(':memory:');
  const { id, kontoId } = await seedFreigabe2Job(db, { pdfPfad: '/tmp/a.pdf' });
  // Simulate an admin editing the Konto after Freigabe 1 completed, so person '1' (who already
  // approved Freigabe 1) is now also resolved as freigeber2 for this Konto.
  updateKonto(db, kontoId, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '1', stellvertreter2Id: '4' });
  const app = buildTestApp(db);

  const getRes = await request(app).get(`/freigabe2/${id}`).set('x-test-person-id', '1');
  assert.equal(getRes.status, 403);
  assert.match(getRes.text, /Vier-Augen-Prinzip/);

  const postRes = await request(app)
    .post(`/freigabe2/${id}`)
    .set('x-test-person-id', '1')
    .type('form')
    .send({ aktion: 'freigeben', interessenskonflikt: 'nein', begruendung: '' });
  assert.equal(postRes.status, 403);

  const job = getJobById(db, id);
  assert.equal(job.status, 'freigabe2', 'the job must not have been approved by the same person twice');
  db.close();
});

test('POST /freigabe2/:id ablehnen sends the rejection email to the admin group with a direct /abgelehnt link when freigabe1_eskaliert_an_admin is set', async () => {
  const db = openDatabase(':memory:');
  const { id } = await seedFreigabe2JobMitAdminEskalation(db, { pdfPfad: '/tmp/a.pdf' });
  const mailer = createStubMailer();
  const app = buildTestApp(db, { mailer });
  const res = await request(app)
    .post(`/freigabe2/${id}`)
    .set('x-test-person-id', '3')
    .type('form')
    .send({ aktion: 'ablehnen', interessenskonflikt: 'nein', begruendung: 'Falsches Konto' });
  assert.equal(res.status, 302);
  assert.equal(mailer.sent.length, 1);
  assert.equal(mailer.sent[0].to, 'admin@example.org');
  assert.match(mailer.sent[0].text, new RegExp(`/abgelehnt/${id}`));
  db.close();
});

test('GET /freigabe2/:id returns 403 for the wrong person even with the buchhaltung role', async () => {
  const db = openDatabase(':memory:');
  const { id } = await seedFreigabe2Job(db, { pdfPfad: '/tmp/a.pdf' });
  const app = buildTestApp(db);
  const res = await request(app).get(`/freigabe2/${id}`).set('x-test-person-id', '2');
  assert.equal(res.status, 403);
  db.close();
});

test('GET /freigabe2/:id returns 403 when the job is not in status freigabe2', async () => {
  const db = openDatabase(':memory:');
  const { id } = await seedFreigabe2Job(db, { pdfPfad: '/tmp/a.pdf' });
  db.prepare("UPDATE jobs SET status = 'zugewiesen' WHERE id = ?").run(id);
  const app = buildTestApp(db);
  const res = await request(app).get(`/freigabe2/${id}`).set('x-test-person-id', '3');
  assert.equal(res.status, 403);
  db.close();
});

test('GET /freigabe2/:id shows the Kontierung summary to the correct freigeber2', async () => {
  const db = openDatabase(':memory:');
  const { id } = await seedFreigabe2Job(db, { pdfPfad: '/tmp/a.pdf' });
  const app = buildTestApp(db);
  const res = await request(app).get(`/freigabe2/${id}`).set('x-test-person-id', '3');
  assert.equal(res.status, 200);
  assert.match(res.text, /3000/);
  assert.match(res.text, /Person1/);
  db.close();
});

test('GET /freigabe2/:id shows betrag, zahlungsziel, lieferant and rechnungsnummer captured during Kontierung', async () => {
  const db = openDatabase(':memory:');
  const { id } = await seedFreigabe2Job(db, { pdfPfad: '/tmp/a.pdf' });
  const { updateKontierungMetadaten } = await import('../../src/db/jobsRepo.js');
  updateKontierungMetadaten(db, id, {
    absender: 'lieferant@example.org',
    betrag: '123.45',
    zahlungsziel: '2026-09-01',
    lieferant: 'Muster AG',
    rechnungsnummer: 'RE-2026-042',
  });
  const app = buildTestApp(db);
  const res = await request(app).get(`/freigabe2/${id}`).set('x-test-person-id', '3');
  assert.equal(res.status, 200);
  assert.match(res.text, /123\.45/);
  assert.match(res.text, /2026-09-01/);
  assert.match(res.text, /Muster AG/);
  assert.match(res.text, /RE-2026-042/);
  db.close();
});

test('GET /freigabe2/:id embeds the preview through the PDF.js viewer, not a raw /downloads iframe', async () => {
  const db = openDatabase(':memory:');
  const { id } = await seedFreigabe2Job(db, { pdfPfad: '/tmp/a.pdf' });
  const app = buildTestApp(db);
  const res = await request(app).get(`/freigabe2/${id}`).set('x-test-person-id', '3');
  assert.equal(res.status, 200);
  assert.match(res.text, /id="freigabe2-preview-frame" data-preview-url="\/downloads\/\d+\?expires=\d+&amp;signature=[0-9a-f]{64}"/);
  assert.match(res.text, /'\/vendor\/pdfjs\/web\/viewer\.html\?file=' \+ encodeURIComponent\(absoluteUrl\)/);
  assert.match(res.text, /id="preview-refresh-btn"/);
  assert.match(res.text, new RegExp(`/downloads/${id}/refresh-url`));
  db.close();
});

test('GET /freigabe2/:id shows an Audit-Log with the Freigabe 1 entry', async () => {
  const db = openDatabase(':memory:');
  const { id } = await seedFreigabe2Job(db, { pdfPfad: '/tmp/a.pdf' });
  const app = buildTestApp(db);
  const res = await request(app).get(`/freigabe2/${id}`).set('x-test-person-id', '3');
  assert.equal(res.status, 200);
  assert.match(res.text, /Audit-Log/);
  assert.match(res.text, /Freigabe 1 erteilt/);
  assert.match(res.text, /Person1/);
  db.close();
});

test('GET /freigabe2/:id shows the quelle and absender that n8n submitted with the job', async () => {
  const db = openDatabase(':memory:');
  for (const id of ['1', '2', '3', '4']) {
    upsertPerson(db, { id, vorname: `Person${id}`, nachname: 'Muster', email: `p${id}@example.org`, gruppen: ['10'], loggedInNow: true });
  }
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  const id = createJob(db, {
    eingangAm: '2026-08-15T08:00:00.000Z',
    quelle: 'lieferant',
    absender: 'buchhaltung@lieferant.example',
    dateiname: 'a.pdf',
    pdfPfad: '/tmp/a.pdf',
  });
  setKontierung(db, id, kontoId);
  createFreigabe(db, { jobId: id, personId: '1', rolle: 'freigeber1', zeitpunkt: '2026-08-15T08:30:00.000Z', ip: '1.2.3.4', interessenskonflikt: false, kommentar: null, eskaliertVon: null });
  db.prepare("UPDATE jobs SET status = 'freigabe2', zugewiesen_an = '1' WHERE id = ?").run(id);
  const app = buildTestApp(db);
  const res = await request(app).get(`/freigabe2/${id}`).set('x-test-person-id', '3');
  assert.equal(res.status, 200);
  assert.match(res.text, /Lieferant/);
  assert.match(res.text, /buchhaltung@lieferant\.example/);
  db.close();
});

test('POST /freigabe2/:id without conflict approves, stamps the PDF and completes the job', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const db = openDatabase(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'freigabe2-test-'));
  const pdfPfad = join(dir, 'a.pdf');
  const pdf = await buildPdfFixture(['Rechnung Seite 1', 'Visum / Rechnungsfreigabe']);
  writeFileSync(pdfPfad, pdf);
  const { id } = await seedFreigabe2Job(db, { pdfPfad });
  const app = buildTestApp(db);

  const res = await request(app)
    .post(`/freigabe2/${id}`)
    .set('x-test-person-id', '3')
    .type('form')
    .send({ interessenskonflikt: 'nein', begruendung: '' });

  assert.equal(res.status, 302);
  const job = getJobById(db, id);
  assert.equal(job.status, 'abgeschlossen');
  const freigaben = listFreigabenByJob(db, id);
  assert.equal(freigaben.length, 2);
  assert.equal(freigaben[1].rolle, 'freigeber2');
  assert.equal(freigaben[1].person_id, '3');

  const { readFileSync } = await import('node:fs');
  const stampedBytes = readFileSync(pdfPfad);
  const mdoc = mupdf.Document.openDocument(stampedBytes, 'application/pdf');
  // The Visum block is stamped onto the visum page itself, which is now second-to-last: Task 2's
  // stampAndFinalize always appends a fresh Verlauf page after it, so the true last page is Verlauf.
  const visumPageText = mdoc.loadPage(mdoc.countPages() - 2).toStructuredText().asText();
  assert.match(visumPageText, /Person1/);
  assert.match(visumPageText, /Person3/);

  rmSync(dir, { recursive: true, force: true });
  db.close();
});

// Fires two requests for the same job "concurrently" (Promise.all), mirroring the pattern used
// for the analogous claimJob race in test/integration/pool.test.js. Real HTTP requests via
// supertest were tried first, but two independent connections to a local Express server reliably
// serialize in this environment (the whole first request/response cycle, including the async PDF
// stamp, finishes before the second connection's data is even dispatched — confirmed empirically
// across many runs) so that test never actually reached the transaction-level race the fix
// guards against. Calling the router's own dispatch function directly, the way Express itself
// invokes a mounted router, reproduces the real race deterministically instead: both calls are
// made back-to-back in the same synchronous tick, so both pass loadAuthorized's synchronous
// status check before either has awaited stampAndFinalize and written anything — the exact
// interleaving described in Finding 2.
function makeRaceContext(req) {
  let resolve;
  const done = new Promise((r) => {
    resolve = r;
  });
  const res = {
    statusCode: 200,
    renderedView: null,
    redirectedTo: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    render(view) {
      this.renderedView = view;
      resolve();
      return this;
    },
    redirect(url) {
      this.redirectedTo = url;
      resolve();
      return this;
    },
  };
  const next = (err) => {
    res.error = err;
    resolve();
  };
  return { req, res, next, done };
}

test('two concurrent POST /freigabe2/:id requests for the same job complete it exactly once', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const db = openDatabase(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'freigabe2-race-test-'));
  const pdfPfad = join(dir, 'a.pdf');
  const pdf = await buildPdfFixture(['Rechnung Seite 1', 'Visum / Rechnungsfreigabe']);
  writeFileSync(pdfPfad, pdf);
  const { id } = await seedFreigabe2Job(db, { pdfPfad });
  const config = { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20' }, downloadSigningSecret: 'test-secret' };
  const router = createFreigabe2Router({ db, config });
  const freigeber2 = getPersonById(db, '3');

  const baseReq = { method: 'POST', url: `/${id}`, originalUrl: `/${id}`, baseUrl: '', params: { id: String(id) }, body: { interessenskonflikt: 'nein', begruendung: '' }, currentPerson: freigeber2 };
  const ctxA = makeRaceContext({ ...baseReq, ip: '1.2.3.4' });
  const ctxB = makeRaceContext({ ...baseReq, ip: '1.2.3.5' });

  router(ctxA.req, ctxA.res, ctxA.next);
  router(ctxB.req, ctxB.res, ctxB.next);
  await Promise.all([ctxA.done, ctxB.done]);

  const outcomes = [ctxA.res, ctxB.res];
  const winners = outcomes.filter((r) => r.redirectedTo === '/pool');
  const losers = outcomes.filter((r) => r.statusCode === 409);
  assert.equal(winners.length, 1, `expected exactly one winning redirect, got ${JSON.stringify(outcomes)}`);
  assert.equal(losers.length, 1, `expected exactly one 409 loser, got ${JSON.stringify(outcomes)}`);
  assert.equal(losers[0].renderedView, 'freigabe2');

  const job = getJobById(db, id);
  assert.equal(job.status, 'abgeschlossen');
  const freigaben = listFreigabenByJob(db, id);
  assert.equal(freigaben.filter((f) => f.rolle === 'freigeber2').length, 1);

  // Prove the fix for the ordering/tmp-path bug, not just the DB-level "exactly once" outcome:
  // the file actually stamped and left on disk must be the WINNER's attempt, not the loser's.
  // Before the fix, renameSync ran before the COMMIT guard, so whichever request's
  // writeFileSync/renameSync happened to run last could clobber the file with the loser's
  // stamp even though the winner's row is the one recorded in the DB.
  const { readFileSync } = await import('node:fs');
  const winnerIp = ctxA.res.redirectedTo === '/pool' ? '1.2.3.4' : '1.2.3.5';
  const loserIp = winnerIp === '1.2.3.4' ? '1.2.3.5' : '1.2.3.4';
  const stampedBytes = readFileSync(pdfPfad);
  const mdoc = mupdf.Document.openDocument(stampedBytes, 'application/pdf');
  // The Visum block (with its "IP: ..." lines) is stamped onto the visum page itself, which is
  // now second-to-last: Task 2's stampAndFinalize always appends a fresh Verlauf page after it.
  const visumPageText = mdoc.loadPage(mdoc.countPages() - 2).toStructuredText().asText();
  assert.match(visumPageText, new RegExp(`IP: ${winnerIp.replace(/\./g, '\\.')}`), 'the stamped file on disk must carry the winning attempt\'s IP');
  assert.doesNotMatch(visumPageText, new RegExp(`IP: ${loserIp.replace(/\./g, '\\.')}`), 'the stamped file on disk must not carry the losing attempt\'s IP');

  rmSync(dir, { recursive: true, force: true });
  db.close();
});

test('POST /freigabe2/:id with a conflict reassigns to stellvertreter2, creates no Freigabe-2 row', async () => {
  const db = openDatabase(':memory:');
  const { id } = await seedFreigabe2Job(db, { pdfPfad: '/tmp/a.pdf' });
  const app = buildTestApp(db);

  const res = await request(app)
    .post(`/freigabe2/${id}`)
    .set('x-test-person-id', '3')
    .type('form')
    .send({ interessenskonflikt: 'ja', begruendung: 'Befangen' });

  assert.equal(res.status, 302);
  const job = getJobById(db, id);
  assert.equal(job.status, 'freigabe2');
  assert.equal(job.freigabe2_eskaliert_von, '3');
  assert.equal(job.freigabe2_eskalationsgrund, 'Befangen');
  assert.equal(listFreigabenByJob(db, id).length, 1);

  const followUp = await request(app).get(`/freigabe2/${id}`).set('x-test-person-id', '3');
  assert.equal(followUp.status, 403);
  const nowAllowed = await request(app).get(`/freigabe2/${id}`).set('x-test-person-id', '4');
  assert.equal(nowAllowed.status, 200);

  db.close();
});

test('POST /freigabe2/:id from an already-escalated stellvertreter2 declaring another conflict now escalates to Portal-Admin instead of being rejected', async () => {
  const db = openDatabase(':memory:');
  const { id } = await seedFreigabe2Job(db, { pdfPfad: '/tmp/a.pdf' });
  eskalierenFreigabe2(db, id, { eskaliertVon: '3', grund: 'Erster Konflikt' });
  const app = buildTestApp(db);

  const res = await request(app)
    .post(`/freigabe2/${id}`)
    .set('x-test-person-id', '4')
    .type('form')
    .send({ interessenskonflikt: 'ja', begruendung: 'Zweiter Konflikt' });

  assert.equal(res.status, 302);
  const job = getJobById(db, id);
  assert.equal(job.freigabe2_eskaliert_an_admin, 1);
  assert.equal(job.status, 'freigabe2');
  assert.equal(job.freigabe2_eskaliert_von, '4');
  assert.equal(job.freigabe2_eskalationsgrund, 'Zweiter Konflikt');
  db.close();
});

test('POST /freigabe2/:id declaring a conflict while also clicking Ablehnen is rejected, not silently escalated', async () => {
  const db = openDatabase(':memory:');
  const { id } = await seedFreigabe2Job(db, { pdfPfad: '/tmp/a.pdf' });
  const app = buildTestApp(db);

  const res = await request(app)
    .post(`/freigabe2/${id}`)
    .set('x-test-person-id', '3')
    .type('form')
    .send({ interessenskonflikt: 'ja', aktion: 'ablehnen', begruendung: 'Falsches Konto' });

  assert.equal(res.status, 400);
  const job = getJobById(db, id);
  assert.equal(job.status, 'freigabe2');
  assert.equal(job.freigabe2_eskaliert_von, null);
  assert.equal(job.abgelehnt_von, null);
  db.close();
});

test('POST /freigabe2/:id with an unstampable PDF leaves the job in freigabe2, creates no row', async () => {
  const { mkdtempSync, rmSync, writeFileSync: write } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const db = openDatabase(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'freigabe2-fail-test-'));
  const pdfPfad = join(dir, 'kaputt.pdf');
  write(pdfPfad, Buffer.alloc(0));
  const { id } = await seedFreigabe2Job(db, { pdfPfad });
  const app = buildTestApp(db);

  const res = await request(app)
    .post(`/freigabe2/${id}`)
    .set('x-test-person-id', '3')
    .type('form')
    .send({ interessenskonflikt: 'nein', begruendung: '' });

  assert.equal(res.status, 400);
  const job = getJobById(db, id);
  assert.equal(job.status, 'freigabe2');
  assert.equal(listFreigabenByJob(db, id).length, 1);

  rmSync(dir, { recursive: true, force: true });
  db.close();
});

test('POST /freigabe2/:id with a missing source PDF forwards to error middleware (500) without leaking the file path', async () => {
  const db = openDatabase(':memory:');
  const pdfPfad = '/tmp/freigabe2-does-not-exist-' + Date.now() + '.pdf';
  const { id } = await seedFreigabe2Job(db, { pdfPfad });
  const app = buildTestApp(db, { withErrorHandler: true });

  const res = await request(app)
    .post(`/freigabe2/${id}`)
    .set('x-test-person-id', '3')
    .type('form')
    .send({ interessenskonflikt: 'nein', begruendung: '' });

  assert.equal(res.status, 500);
  assert.match(res.text, /unerwarteter Fehler/);
  assert.doesNotMatch(res.text, new RegExp(pdfPfad.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const job = getJobById(db, id);
  assert.equal(job.status, 'freigabe2');
  db.close();
});

test('POST /freigabe2/:id forwards a genuine post-stamp write failure to error middleware instead of crashing', async () => {
  const { mkdtempSync, rmSync, chmodSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const db = openDatabase(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'freigabe2-writefail-test-'));
  const pdfPfad = join(dir, 'a.pdf');
  const pdf = await buildPdfFixture(['Rechnung Seite 1', 'Visum / Rechnungsfreigabe']);
  writeFileSync(pdfPfad, pdf);
  const { id } = await seedFreigabe2Job(db, { pdfPfad });
  const app = buildTestApp(db, { withErrorHandler: true });

  // The PDF is readable (stampAndFinalize succeeds) but the directory is read-only, so
  // writeFileSync(tmpPfad, stamped) throws EACCES -- a genuine unexpected disk-write failure,
  // not a "this PDF is unstampable" business error. Without Finding 1's fix this throws inside
  // an async handler with nothing to catch it.
  chmodSync(dir, 0o500);
  try {
    const res = await request(app)
      .post(`/freigabe2/${id}`)
      .set('x-test-person-id', '3')
      .type('form')
      .send({ interessenskonflikt: 'nein', begruendung: '' });

    assert.equal(res.status, 500);
    assert.match(res.text, /unerwarteter Fehler/);
    const job = getJobById(db, id);
    assert.equal(job.status, 'freigabe2');
  } finally {
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
    db.close();
  }
});

test('POST /freigabe2/:id with aktion=ablehnen and a Begründung rejects the job', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const db = openDatabase(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'freigabe2-ablehnen-test-'));
  const pdfPfad = join(dir, 'a.pdf');
  const pdf = await buildPdfFixture(['Rechnung Seite 1', 'Visum / Rechnungsfreigabe']);
  writeFileSync(pdfPfad, pdf);
  const { id } = await seedFreigabe2Job(db, { pdfPfad });
  const app = buildTestApp(db);

  const res = await request(app)
    .post(`/freigabe2/${id}`)
    .set('x-test-person-id', '3')
    .type('form')
    .send({ aktion: 'ablehnen', interessenskonflikt: 'nein', begruendung: 'Falsches Konto gewählt' });

  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/pool');
  const job = getJobById(db, id);
  assert.equal(job.status, 'abgelehnt');
  assert.equal(job.abgelehnt_von, '3');
  assert.equal(job.ablehnungsgrund, 'Falsches Konto gewählt');

  const freigaben = listFreigabenByJob(db, id);
  const ablehnung = freigaben.find((f) => f.rolle === 'ablehnung');
  assert.ok(ablehnung, 'the rejection must be logged in freigaben for the audit trail');
  assert.equal(ablehnung.person_id, '3');
  assert.equal(ablehnung.kommentar, 'Falsches Konto gewählt');

  rmSync(dir, { recursive: true, force: true });
  db.close();
});

test('POST /freigabe2/:id with aktion=ablehnen and no Begründung is rejected with 400', async () => {
  const db = openDatabase(':memory:');
  const { id } = await seedFreigabe2Job(db, { pdfPfad: '/tmp/a.pdf' });
  const app = buildTestApp(db);

  const res = await request(app)
    .post(`/freigabe2/${id}`)
    .set('x-test-person-id', '3')
    .type('form')
    .send({ aktion: 'ablehnen', interessenskonflikt: 'nein', begruendung: '' });

  assert.equal(res.status, 400);
  const job = getJobById(db, id);
  assert.equal(job.status, 'freigabe2');
  db.close();
});

test('POST /freigabe2/:id with aktion=ablehnen on a job with an unstampable PDF still rejects cleanly (no stamping is attempted)', async () => {
  const db = openDatabase(':memory:');
  const { id } = await seedFreigabe2Job(db, { pdfPfad: '/nonexistent/path.pdf' });
  const app = buildTestApp(db);

  const res = await request(app)
    .post(`/freigabe2/${id}`)
    .set('x-test-person-id', '3')
    .type('form')
    .send({ aktion: 'ablehnen', interessenskonflikt: 'nein', begruendung: 'zu spät' });

  assert.equal(res.status, 302);
  assert.equal(getJobById(db, id).status, 'abgelehnt');
  db.close();
});

test('after a rejected job is reworked and resubmitted through Kontierung, Freigabe 2 shows and stamps the newest Freigabe-1 row, not the stale one', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const db = openDatabase(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'freigabe2-findlast-test-'));
  const pdfPfad = join(dir, 'a.pdf');
  const pdf = await buildPdfFixture(['Rechnung Seite 1', 'Visum / Rechnungsfreigabe']);
  writeFileSync(pdfPfad, pdf);
  const { id, kontoId } = await seedFreigabe2Job(db, { pdfPfad });

  // Reject the job, then simulate the rework cycle directly at the repo level (Task 4 builds
  // the actual /abgelehnt route; this test only needs the resulting data shape).
  const { ablehnenJob, wiederOeffnenJob } = await import('../../src/db/jobsRepo.js');
  ablehnenJob(db, id, { abgelehntVon: '3', grund: 'Falsches Konto' });
  // jobsRepo's ablehnenJob only updates the jobs row (Task 1's scope); the audit trail row is
  // created by the POST /freigabe2 route's own createFreigabe call (see Step 3 above). Since this
  // test bypasses that route to simulate the rework cycle directly, it must add the same audit
  // row here to match the data shape a real rejection would have left behind.
  createFreigabe(db, { jobId: id, personId: '3', rolle: 'ablehnung', zeitpunkt: '2026-08-15T09:00:00.000Z', ip: '1.2.3.4', interessenskonflikt: false, kommentar: 'Falsches Konto', eskaliertVon: null });
  wiederOeffnenJob(db, id, '1');
  // A second, newer Freigabe-1 approval for the same job — this is what .find() would miss.
  createFreigabe(db, { jobId: id, personId: '1', rolle: 'freigeber1', zeitpunkt: '2026-08-15T10:00:00.000Z', ip: '9.9.9.9', interessenskonflikt: false, kommentar: null, eskaliertVon: null });
  db.prepare("UPDATE jobs SET status = 'freigabe2' WHERE id = ?").run(id);

  const app = buildTestApp(db);
  const viewRes = await request(app).get(`/freigabe2/${id}`).set('x-test-person-id', '3');
  assert.equal(viewRes.status, 200);

  const freigebenRes = await request(app)
    .post(`/freigabe2/${id}`)
    .set('x-test-person-id', '3')
    .type('form')
    .send({ aktion: 'freigeben', interessenskonflikt: 'nein', begruendung: '' });
  assert.equal(freigebenRes.status, 302);

  const stampedPdf = readFileSync(pdfPfad);
  const doc = mupdf.Document.openDocument(stampedPdf, 'application/pdf');
  // The Visum page (second-to-last: original page + Visum + 1 Verlauf page) must carry the
  // NEW Freigabe-1 row's IP (9.9.9.9), not the original, superseded row's IP (1.2.3.4) — this
  // is the assertion that actually distinguishes .find() (would pick the old row) from
  // .findLast() (picks the new one); both rows belong to the same person, so name alone can't
  // tell them apart.
  const visumPageText = doc.loadPage(doc.countPages() - 2).toStructuredText().asText();
  assert.match(visumPageText, /9\.9\.9\.9/, 'the operative Freigabe-1 block must use the newest row (proves .findLast, not .find)');
  assert.doesNotMatch(visumPageText, /1\.2\.3\.4/, 'the stale, superseded Freigabe-1 row must not be the one stamped as operative');

  const verlaufPageText = doc.loadPage(doc.countPages() - 1).toStructuredText().asText();
  assert.match(verlaufPageText, /Abgelehnt/, 'the Verlauf page must include the original rejection');
  assert.match(verlaufPageText, /Falsches Konto/);
  // Verlauf entries (unlike the Visum block) carry no IP — pdfStamp.js's verlaufEntryLines only
  // renders timestamp/role/name/comment (see src/services/pdfStamp.js, out of this task's scope).
  // So the superseded Freigabe-1 row is identified here by its original timestamp (10:30, i.e.
  // 2026-08-15T08:30:00.000Z from seedFreigabe2Job) rather than by IP.
  assert.match(verlaufPageText, /10:30 — Freigabe 1/, 'the Verlauf, unlike the Visum block, must still show the superseded row for the full audit trail');

  rmSync(dir, { recursive: true, force: true });
  db.close();
});

test('POST /freigabe2/:id with aktion=ablehnen on a job someone else already handled returns 403 via loadAuthorized, no double transition', async () => {
  const db = openDatabase(':memory:');
  const { id } = await seedFreigabe2Job(db, { pdfPfad: '/tmp/a.pdf' });
  const app = buildTestApp(db);
  // Simulate another process having already moved the job out of freigabe2 (e.g. a concurrent
  // Freigeben) between this request's authorization check and its ablehnenJob call.
  db.prepare("UPDATE jobs SET status = 'abgeschlossen' WHERE id = ?").run(id);

  const res = await request(app)
    .post(`/freigabe2/${id}`)
    .set('x-test-person-id', '3')
    .type('form')
    .send({ aktion: 'ablehnen', interessenskonflikt: 'nein', begruendung: 'zu spät' });

  // loadAuthorized itself already 403s once status !== 'freigabe2', so this is the same
  // access-control path as any other stale-status request — confirms no partial state change.
  assert.equal(res.status, 403);
  assert.equal(getJobById(db, id).status, 'abgeschlossen');
  db.close();
});

test('POST /freigabe2/:id with a conflict sends a Zuweisungs-Mail to stellvertreter2', async () => {
  const db = openDatabase(':memory:');
  const { id } = await seedFreigabe2Job(db, { pdfPfad: '/tmp/a.pdf' }); // freigeber2Id: '3', stellvertreter2Id: '4'
  const mailer = createStubMailer();
  const app = buildTestApp(db, { mailer });

  const res = await request(app)
    .post(`/freigabe2/${id}`)
    .set('x-test-person-id', '3')
    .type('form')
    .send({ interessenskonflikt: 'ja', begruendung: 'Befangen' });

  assert.equal(res.status, 302);
  assert.equal(mailer.sent.length, 1);
  assert.equal(mailer.sent[0].to, 'p4@example.org');
  assert.match(mailer.sent[0].text, new RegExp(`/freigabe2/${id}`));
  db.close();
});

test('POST /freigabe2/:id with aktion=ablehnen sends an Ablehnungs-Benachrichtigung to the job owner, including the reason', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const db = openDatabase(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'freigabe2-mail-ablehnen-test-'));
  const pdfPfad = join(dir, 'a.pdf');
  const pdf = await buildPdfFixture(['Rechnung Seite 1', 'Visum / Rechnungsfreigabe']);
  writeFileSync(pdfPfad, pdf);
  const { id } = await seedFreigabe2Job(db, { pdfPfad });
  const mailer = createStubMailer();
  const app = buildTestApp(db, { mailer });

  const res = await request(app)
    .post(`/freigabe2/${id}`)
    .set('x-test-person-id', '3')
    .type('form')
    .send({ aktion: 'ablehnen', interessenskonflikt: 'nein', begruendung: 'Falsches Konto gewählt' });

  assert.equal(res.status, 302);
  assert.equal(mailer.sent.length, 1);
  assert.equal(mailer.sent[0].to, 'p1@example.org'); // seedFreigabe2Job's zugewiesen_an is person '1'
  assert.match(mailer.sent[0].text, /Falsches Konto gewählt/);
  assert.match(mailer.sent[0].text, new RegExp(`/abgelehnt/${id}`));

  rmSync(dir, { recursive: true, force: true });
  db.close();
});

test('POST /freigabe2/:id with aktion=freigeben (no conflict, no rejection) sends no mail — job completion needs no human notification', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const db = openDatabase(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'freigabe2-mail-freigeben-test-'));
  const pdfPfad = join(dir, 'a.pdf');
  const pdf = await buildPdfFixture(['Rechnung Seite 1', 'Visum / Rechnungsfreigabe']);
  writeFileSync(pdfPfad, pdf);
  const { id } = await seedFreigabe2Job(db, { pdfPfad });
  const mailer = createStubMailer();
  const app = buildTestApp(db, { mailer });

  const res = await request(app)
    .post(`/freigabe2/${id}`)
    .set('x-test-person-id', '3')
    .type('form')
    .send({ aktion: 'freigeben', interessenskonflikt: 'nein', begruendung: '' });

  assert.equal(res.status, 302);
  assert.equal(mailer.sent.length, 0);

  rmSync(dir, { recursive: true, force: true });
  db.close();
});

test('a Stellvertreter2 who is escalated to and ALSO has a conflict escalates to Portal-Admin instead of being blocked', async () => {
  const config = testConfig();
  const client = setupMockChurchTools(config.churchtools.baseUrl);
  const db = openDatabase(':memory:');
  const { upsertPerson } = await import('../../src/db/personenRepo.js');
  const { createKonto } = await import('../../src/db/kontenRepo.js');
  const { createJob, getJobById } = await import('../../src/db/jobsRepo.js');
  const { createFreigabe } = await import('../../src/db/freigabenRepo.js');
  const { listMailLog } = await import('../../src/db/mailLogRepo.js');

  upsertPerson(db, { id: '1', vorname: 'Freigeber', nachname: 'Eins', email: 'f1@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '2', vorname: 'Stellvertreter', nachname: 'Eins', email: 's1@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '3', vorname: 'Freigeber', nachname: 'Zwei', email: 'f2@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '4', vorname: 'Stellvertreter', nachname: 'Zwei', email: 's2@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '99', vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'], loggedInNow: false });
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  const jobId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare("UPDATE jobs SET status = 'freigabe2', konto_id = ? WHERE id = ?").run(kontoId, jobId);
  createFreigabe(db, { jobId, personId: '1', rolle: 'freigeber1', zeitpunkt: new Date().toISOString(), ip: '127.0.0.1', interessenskonflikt: false, kommentar: null, eskaliertVon: null });

  const app = createApp({ db, config });
  const freigeber2Agent = await loginAs(app, client, { id: 3, vorname: 'Freigeber', nachname: 'Zwei', email: 'f2@example.org', gruppen: ['10'] });
  await freigeber2Agent.post(`/freigabe2/${jobId}`).type('form').send({ interessenskonflikt: 'ja', begruendung: 'Ich bin befangen.' });
  assert.equal(getJobById(db, jobId).freigabe2_eskaliert_von, '3');

  const stellvertreter2Agent = await loginAs(app, client, { id: 4, vorname: 'Stellvertreter', nachname: 'Zwei', email: 's2@example.org', gruppen: ['10'] });
  const res = await stellvertreter2Agent.post(`/freigabe2/${jobId}`).type('form').send({ interessenskonflikt: 'ja', begruendung: 'Ich bin auch befangen.' });

  assert.equal(res.status, 302, 'the second escalation should succeed, not render the form with an error');
  const job = getJobById(db, jobId);
  assert.equal(job.freigabe2_eskaliert_an_admin, 1);
  assert.equal(job.status, 'freigabe2');

  const adminMails = listMailLog(db).filter((m) => m.typ === 'zuweisung' && m.empfaenger === 'admin@example.org');
  assert.equal(adminMails.length, 1);
  // The notification must link directly to the job, not the generic /pool page — a Portal-Admin
  // clicking through from this email is the only realistic way they discover an escalated job.
  assert.match(adminMails[0].text, new RegExp(`/freigabe2/${jobId}(?!\\d)`));
  assert.doesNotMatch(adminMails[0].text, /\/pool/);

  const blockedAgent = await loginAs(app, client, { id: 4, vorname: 'Stellvertreter', nachname: 'Zwei', email: 's2@example.org', gruppen: ['10'] });
  const blockedRes = await blockedAgent.get(`/freigabe2/${jobId}`);
  assert.equal(blockedRes.status, 403);

  const adminAgent = await loginAs(app, client, { id: 99, vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'] });
  const adminRes = await adminAgent.get(`/freigabe2/${jobId}`);
  assert.equal(adminRes.status, 200);
  db.close();
});
