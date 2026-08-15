import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { writeFileSync } from 'node:fs';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createKonto } from '../../src/db/kontenRepo.js';
import { createJob, setKontierung, getJobById } from '../../src/db/jobsRepo.js';
import { createFreigabe, listFreigabenByJob } from '../../src/db/freigabenRepo.js';
import { loadCurrentPerson, requireRole } from '../../src/middleware/roles.js';
import { createFreigabe2Router } from '../../src/routes/freigabe2.js';
import { buildPdfFixture } from '../helpers/pdfFixture.js';
import * as mupdf from 'mupdf';

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
  const config = { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20' }, downloadSigningSecret: 'test-secret' };
  app.use(loadCurrentPerson(db));
  app.use('/freigabe2', requireRole(config, 'buchhaltung'), createFreigabe2Router({ db, config }));
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
