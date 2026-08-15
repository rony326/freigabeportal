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

test('POST /freigabe2/:id from an already-escalated stellvertreter2 declaring another conflict is rejected, not re-escalated to self', async () => {
  const db = openDatabase(':memory:');
  const { id } = await seedFreigabe2Job(db, { pdfPfad: '/tmp/a.pdf' });
  eskalierenFreigabe2(db, id, { eskaliertVon: '3', grund: 'Erster Konflikt' });
  const app = buildTestApp(db);

  const res = await request(app)
    .post(`/freigabe2/${id}`)
    .set('x-test-person-id', '4')
    .type('form')
    .send({ interessenskonflikt: 'ja', begruendung: 'Zweiter Konflikt' });

  assert.equal(res.status, 400);
  const job = getJobById(db, id);
  assert.equal(job.status, 'freigabe2');
  assert.equal(job.freigabe2_eskaliert_von, '3');
  assert.equal(job.freigabe2_eskalationsgrund, 'Erster Konflikt');
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
