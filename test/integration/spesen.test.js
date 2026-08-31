import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createKonto, deactivateKonto } from '../../src/db/kontenRepo.js';
import { getJobById } from '../../src/db/jobsRepo.js';
import { buildPdfFixture } from '../helpers/pdfFixture.js';
import { PNG_1X1 } from '../helpers/imageFixture.js';
import { loadCurrentPerson, requireLogin } from '../../src/middleware/roles.js';
import { loadNavFlags } from '../../src/middleware/nav.js';
import { createSpesenRouter } from '../../src/routes/spesen.js';
import { fetchCsrfToken } from '../helpers/csrf.js';

function createStubMailer() {
  const sent = [];
  return { sent, async sendMail(mail) { sent.push(mail); } };
}

function testConfig() {
  return { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20' }, downloadSigningSecret: 'test-secret', jobsDir: '/tmp', publicBaseUrl: 'https://portal.example.org' };
}

function buildTestApp(db, mailer, config = testConfig()) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', new URL('../../views', import.meta.url).pathname);
  app.use((req, res, next) => {
    res.locals.branding = { primaryColor: '#000', secondaryColor: '#fff', hasLogo: false, themeAttr: null };
    next();
  });
  app.use((req, res, next) => {
    req.session = { personId: req.headers['x-test-person-id'] };
    next();
  });
  app.use(loadCurrentPerson(db));
  app.use(loadNavFlags(db, config));
  const csrfProtection = (req, res, next) => {
    if (req.body?._csrf === 'valid-token') return next();
    return res.status(403).send('invalid csrf');
  };
  app.use((req, res, next) => {
    res.locals.csrfToken = 'valid-token';
    next();
  });
  app.use('/spesen', requireLogin(), createSpesenRouter({ db, config, mailer, csrfProtection }));
  return app;
}

function seedGrundlagen(db) {
  upsertPerson(db, { id: '1', vorname: 'Frei', nachname: 'Geber1', email: 'f1@example.org', gruppen: [] });
  upsertPerson(db, { id: '2', vorname: 'Stell', nachname: 'Vertreter1', email: 's1@example.org', gruppen: [] });
  upsertPerson(db, { id: '3', vorname: 'Frei', nachname: 'Geber2', email: 'f2@example.org', gruppen: [] });
  upsertPerson(db, { id: '4', vorname: 'Stell', nachname: 'Vertreter2', email: 's2@example.org', gruppen: [] });
  upsertPerson(db, { id: '5', vorname: 'Ein', nachname: 'Reicher', email: 'e@example.org', gruppen: [] });
  return createKonto(db, { kontonummer: '1000', bezeichnung: 'Reisespesen', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
}

test('GET /spesen/neu requires login', async () => {
  const db = openDatabase(':memory:');
  const app = buildTestApp(db, createStubMailer());
  const res = await request(app).get('/spesen/neu');
  assert.equal(res.status, 401);
  db.close();
});

test('GET /spesen/neu lists every active Konto regardless of the current person\'s roles', async () => {
  const db = openDatabase(':memory:');
  seedGrundlagen(db);
  const app = buildTestApp(db, createStubMailer());
  const res = await request(app).get('/spesen/neu').set('x-test-person-id', '5');
  assert.equal(res.status, 200);
  assert.match(res.text, /1000/);
  assert.match(res.text, /Reisespesen/);
  db.close();
});

test('POST /spesen creates one job per position, assigned to the Konto Freigeber1, status zugewiesen', async () => {
  const db = openDatabase(':memory:');
  const kontoId = seedGrundlagen(db);
  const mailer = createStubMailer();
  const app = buildTestApp(db, mailer);
  const pdf = await buildPdfFixture(['Beleg 1']);

  const res = await request(app)
    .post('/spesen')
    .set('x-test-person-id', '5')
    .field('_csrf', 'valid-token')
    .field('titel', 'Reise Zürich')
    .field('posKontoId', String(kontoId))
    .field('posBetrag', '61.75')
    .field('posAuslageDatum', '2026-08-20')
    .field('posBeschreibung', 'Bahnticket')
    .attach('posBeleg_0', pdf, { filename: 'ticket.pdf', contentType: 'application/pdf' });

  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/pool');
  const job = db.prepare("SELECT * FROM jobs WHERE quelle = 'spesen'").get();
  assert.equal(job.status, 'zugewiesen');
  assert.equal(job.zugewiesen_an, '1');
  assert.equal(job.eingereicht_von, '5');
  assert.equal(job.beschreibung, 'Bahnticket');
  assert.equal(job.auslage_datum, '2026-08-20');
  assert.equal(job.betrag, '61.75');
  assert.equal(mailer.sent.length, 1);
  assert.equal(mailer.sent[0].to, 'f1@example.org');
  db.close();
});

test('POST /spesen with two positions on different Konten creates two independent jobs', async () => {
  const db = openDatabase(':memory:');
  const kontoId1 = seedGrundlagen(db);
  const kontoId2 = createKonto(db, { kontonummer: '2000', bezeichnung: 'Büromaterial', freigeber1Id: '3', stellvertreter1Id: '4', freigeber2Id: '1', stellvertreter2Id: '2' });
  const app = buildTestApp(db, createStubMailer());
  const pdf = await buildPdfFixture(['Beleg']);

  const res = await request(app)
    .post('/spesen')
    .set('x-test-person-id', '5')
    .field('_csrf', 'valid-token')
    .field('posKontoId', [String(kontoId1), String(kontoId2)])
    .field('posBetrag', ['10.00', '20.00'])
    .field('posAuslageDatum', ['2026-08-20', '2026-08-21'])
    .field('posBeschreibung', ['Taxi', 'Toner'])
    .attach('posBeleg_0', pdf, { filename: 'a.pdf', contentType: 'application/pdf' })
    .attach('posBeleg_1', pdf, { filename: 'b.pdf', contentType: 'application/pdf' });

  assert.equal(res.status, 302);
  const jobs = db.prepare("SELECT * FROM jobs WHERE quelle = 'spesen' ORDER BY betrag").all();
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].konto_id, kontoId1);
  assert.equal(jobs[1].konto_id, kontoId2);
  db.close();
});

test('POST /spesen escalates to Stellvertreter1 and sets the escalation reason when the submitter is the Konto\'s own Freigeber1', async () => {
  const db = openDatabase(':memory:');
  const kontoId = seedGrundlagen(db);
  const mailer = createStubMailer();
  const app = buildTestApp(db, mailer);
  const pdf = await buildPdfFixture(['Beleg']);

  const res = await request(app)
    .post('/spesen')
    .set('x-test-person-id', '1') // person '1' is this Konto's own Freigeber1
    .field('_csrf', 'valid-token')
    .field('posKontoId', String(kontoId))
    .field('posBetrag', '10.00')
    .field('posAuslageDatum', '2026-08-20')
    .field('posBeschreibung', 'Parkgebühr')
    .attach('posBeleg_0', pdf, { filename: 'a.pdf', contentType: 'application/pdf' });

  assert.equal(res.status, 302);
  const job = db.prepare("SELECT * FROM jobs WHERE quelle = 'spesen'").get();
  assert.equal(job.zugewiesen_an, '2', 'must reassign to Stellvertreter1, never the submitter');
  assert.equal(job.freigabe1_eskaliert_von, '1');
  assert.equal(job.freigabe1_eskalationsgrund, 'Selbsteinreichung durch Freigeber1');
  const eintrag = db.prepare("SELECT * FROM freigaben WHERE job_id = ? AND rolle = 'freigabe1_eskalation'").get(job.id);
  assert.ok(eintrag, 'the auto-escalation must be logged as a freigaben row so the audit log shows the reason');
  assert.equal(eintrag.kommentar, 'Selbsteinreichung durch Freigeber1');
  assert.equal(mailer.sent[0].to, 's1@example.org');
  db.close();
});

test('POST /spesen rejects a position with an inactive Konto', async () => {
  const db = openDatabase(':memory:');
  const kontoId = seedGrundlagen(db);
  deactivateKonto(db, kontoId);
  const app = buildTestApp(db, createStubMailer());
  const pdf = await buildPdfFixture(['Beleg']);

  const res = await request(app)
    .post('/spesen')
    .set('x-test-person-id', '5')
    .field('_csrf', 'valid-token')
    .field('posKontoId', String(kontoId))
    .field('posBetrag', '10.00')
    .field('posAuslageDatum', '2026-08-20')
    .field('posBeschreibung', 'x')
    .attach('posBeleg_0', pdf, { filename: 'a.pdf', contentType: 'application/pdf' });

  assert.equal(res.status, 400);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE quelle = 'spesen'").get().n, 0);
  db.close();
});

test('POST /spesen rejects a position with a future Auslage-Datum', async () => {
  const db = openDatabase(':memory:');
  const kontoId = seedGrundlagen(db);
  const app = buildTestApp(db, createStubMailer());
  const pdf = await buildPdfFixture(['Beleg']);

  const res = await request(app)
    .post('/spesen')
    .set('x-test-person-id', '5')
    .field('_csrf', 'valid-token')
    .field('posKontoId', String(kontoId))
    .field('posBetrag', '10.00')
    .field('posAuslageDatum', '2999-01-01')
    .field('posBeschreibung', 'x')
    .attach('posBeleg_0', pdf, { filename: 'a.pdf', contentType: 'application/pdf' });

  assert.equal(res.status, 400);
  db.close();
});

test('POST /spesen rejects a position missing its Beleg', async () => {
  const db = openDatabase(':memory:');
  const kontoId = seedGrundlagen(db);
  const app = buildTestApp(db, createStubMailer());

  const res = await request(app)
    .post('/spesen')
    .set('x-test-person-id', '5')
    .field('_csrf', 'valid-token')
    .field('posKontoId', String(kontoId))
    .field('posBetrag', '10.00')
    .field('posAuslageDatum', '2026-08-20')
    .field('posBeschreibung', 'x');

  assert.equal(res.status, 400);
  db.close();
});

test('POST /spesen accepts a PNG Beleg and wraps it into a standalone PDF', async () => {
  const db = openDatabase(':memory:');
  const kontoId = seedGrundlagen(db);
  const app = buildTestApp(db, createStubMailer());

  const res = await request(app)
    .post('/spesen')
    .set('x-test-person-id', '5')
    .field('_csrf', 'valid-token')
    .field('posKontoId', String(kontoId))
    .field('posBetrag', '10.00')
    .field('posAuslageDatum', '2026-08-20')
    .field('posBeschreibung', 'x')
    .attach('posBeleg_0', PNG_1X1, { filename: 'beleg.png', contentType: 'image/png' });

  assert.equal(res.status, 302);
  const job = db.prepare("SELECT * FROM jobs WHERE quelle = 'spesen'").get();
  assert.ok(job.pdf_pfad.endsWith('.pdf'));
  db.close();
});
