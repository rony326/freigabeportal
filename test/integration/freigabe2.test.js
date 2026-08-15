import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { writeFileSync } from 'node:fs';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson, getPersonById } from '../../src/db/personenRepo.js';
import { createKonto } from '../../src/db/kontenRepo.js';
import { createJob, setKontierung, getJobById } from '../../src/db/jobsRepo.js';
import { createFreigabe, listFreigabenByJob } from '../../src/db/freigabenRepo.js';
import { loadCurrentPerson, requireRole } from '../../src/middleware/roles.js';
import { createFreigabe2Router } from '../../src/routes/freigabe2.js';
import { buildPdfFixture } from '../helpers/pdfFixture.js';
import * as mupdf from 'mupdf';

function buildTestApp(db, { withErrorHandler = false } = {}) {
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
  const config = { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20' }, downloadSigningSecret: 'test-secret' };
  app.use(loadCurrentPerson(db));
  app.use('/freigabe2', requireRole(config, 'buchhaltung'), createFreigabe2Router({ db, config }));
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
  db.prepare("UPDATE jobs SET status = 'freigabe2' WHERE id = ?").run(id);
  return { id, kontoId };
}

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
  const lastPageText = mdoc.loadPage(mdoc.countPages() - 1).toStructuredText().asText();
  assert.match(lastPageText, /Person1/);
  assert.match(lastPageText, /Person3/);

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
