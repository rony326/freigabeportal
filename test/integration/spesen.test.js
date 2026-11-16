import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createKonto, deactivateKonto } from '../../src/db/kontenRepo.js';
import { getJobById } from '../../src/db/jobsRepo.js';
import { buildPdfFixture } from '../helpers/pdfFixture.js';
import { PNG_1X1, buildPngHeaderOnly } from '../helpers/imageFixture.js';
import { loadCurrentPerson, requireLogin } from '../../src/middleware/roles.js';
import { loadNavFlags } from '../../src/middleware/nav.js';
import { createSpesenRouter } from '../../src/routes/spesen.js';
import { setConfigValue, seedDefaults } from '../../src/db/adminConfigRepo.js';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mitPdfStoerung } from '../helpers/pdfStoerung.js';

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
  seedDefaults(db);
  const app = buildTestApp(db, createStubMailer());
  const res = await request(app).get('/spesen/neu');
  assert.equal(res.status, 401);
  db.close();
});

test('GET /spesen/neu returns 403 when the Spesenmodul is deactivated', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedGrundlagen(db);
  setConfigValue(db, 'modul_spesen_aktiv', '0');
  const app = buildTestApp(db, createStubMailer());
  const res = await request(app).get('/spesen/neu').set('x-test-person-id', '5');
  assert.equal(res.status, 403);
  db.close();
});

test('POST /spesen returns 403 and creates no job when the Spesenmodul is deactivated', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedGrundlagen(db);
  setConfigValue(db, 'modul_spesen_aktiv', '0');
  const app = buildTestApp(db, createStubMailer());
  const res = await request(app)
    .post('/spesen')
    .set('x-test-person-id', '5')
    .field('_csrf', 'valid-token')
    .field('posKontoId', '1')
    .field('posBetrag', '10.00')
    .field('posAuslageDatum', '2026-01-01')
    .field('posBeschreibung', 'Test');
  assert.equal(res.status, 403);
  db.close();
});

test('GET /spesen/neu lists every active Konto regardless of the current person\'s roles', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
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
  seedDefaults(db);
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
  seedDefaults(db);
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
  seedDefaults(db);
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
  seedDefaults(db);
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
  seedDefaults(db);
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
  seedDefaults(db);
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
  seedDefaults(db);
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
  assert.equal(job.dateiname, 'beleg.pdf', 'the served bytes are always a PDF, so the download filename must be too, not the original .png');
  db.close();
});

test('POST /spesen with every position row removed re-renders the form with a working "+ Position hinzufügen" button and the Konto-Optionen template, not a bare live row', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedGrundlagen(db);
  const app = buildTestApp(db, createStubMailer());

  // Simulates the "all rows removed via Entfernen, then submit" case: no posKontoId (or any
  // other position field) is present at all, so positionen resolves to [] server-side.
  const res = await request(app).post('/spesen').set('x-test-person-id', '5').field('_csrf', 'valid-token');

  assert.equal(res.status, 400);
  assert.match(res.text, /Mindestens eine Position ist erforderlich\./);
  // The view must not rely on a live '.position-zeile select' to source Konto options — with
  // zero rows, only the unconditionally-rendered <template> can supply them.
  assert.match(res.text, /<template id="konto-optionen-template">/);
  assert.match(res.text, /id="zeile-hinzufuegen"/);
  assert.doesNotMatch(res.text, /class="[^"]*position-zeile[^"]*"/, 'no position rows should be rendered for an empty positionen array');
  db.close();
});

test('POST /spesen with a Beleg exceeding MAX_BELEG_SIZE 400s with a form re-render, not a 500', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  const kontoId = seedGrundlagen(db);
  const app = buildTestApp(db, createStubMailer());
  // MAX_BELEG_SIZE is 20 MiB — one byte over trips multer's LIMIT_FILE_SIZE error.
  const oversizedBeleg = Buffer.alloc(20 * 1024 * 1024 + 1, 1);

  const res = await request(app)
    .post('/spesen')
    .set('x-test-person-id', '5')
    .field('_csrf', 'valid-token')
    .field('posKontoId', String(kontoId))
    .field('posBetrag', '10.00')
    .field('posAuslageDatum', '2026-08-20')
    .field('posBeschreibung', 'x')
    .attach('posBeleg_0', oversizedBeleg, { filename: 'zugross.pdf', contentType: 'application/pdf' });

  assert.equal(res.status, 400);
  assert.match(res.text, /höchstens 20 MB/);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM jobs WHERE quelle = 'spesen'").get().c, 0, 'no job may be created out of a rejected upload');
  db.close();
});

test('POST /spesen rejects a damaged or encrypted PDF Beleg with an understandable message and creates no job', async () => {
  const { buildVerschluesseltesPdfFixture } = await import('../helpers/pdfFixture.js');
  for (const [bytes, meldung] of [
    [Buffer.from('%PDF-1.4\n%kaputt\n'), /beschädigt/],
    [await buildVerschluesseltesPdfFixture(), /verschlüsselt/],
  ]) {
    const db = openDatabase(':memory:');
    seedDefaults(db);
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
      .attach('posBeleg_0', bytes, { filename: 'a.pdf', contentType: 'application/pdf' });

    assert.equal(res.status, 400);
    assert.match(res.text, /Position 1:/);
    assert.match(res.text, meldung);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE quelle = 'spesen'").get().n, 0);
    db.close();
  }
});

// --- Buchungsart: Spesen zählen als Rechnung ---

test('Spesen: reine Gutschrift-Konten stehen nicht zur Auswahl, Rechnung und beides schon', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedGrundlagen(db);
  createKonto(db, { kontonummer: '2000', bezeichnung: 'NurGutschrift', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4', buchungsart: 'gutschrift' });
  createKonto(db, { kontonummer: '3000', bezeichnung: 'NurRechnung', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4', buchungsart: 'rechnung' });
  const res = await request(buildTestApp(db, createStubMailer())).get('/spesen/neu').set('x-test-person-id', '5');
  assert.equal(res.status, 200);
  assert.doesNotMatch(res.text, /NurGutschrift/);
  assert.match(res.text, /NurRechnung/);
  assert.match(res.text, /Reisespesen/);
  db.close();
});

test('POST /spesen mit einem reinen Gutschrift-Konto wird abgelehnt, kein Job angelegt', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedGrundlagen(db);
  const gutschriftKonto = createKonto(db, { kontonummer: '2000', bezeichnung: 'NurGutschrift', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4', buchungsart: 'gutschrift' });
  const pdf = await buildPdfFixture(['Beleg']);
  const res = await request(buildTestApp(db, createStubMailer()))
    .post('/spesen').set('x-test-person-id', '5').field('_csrf', 'valid-token')
    .field('posKontoId', String(gutschriftKonto)).field('posBetrag', '10.00').field('posAuslageDatum', '2026-08-20').field('posBeschreibung', 'x')
    .attach('posBeleg_0', pdf, { filename: 'a.pdf', contentType: 'application/pdf' });
  assert.equal(res.status, 400);
  assert.match(res.text, /kann nicht für Rechnungen verwendet werden/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE quelle = 'spesen'").get().n, 0);
  db.close();
});

test('POST /spesen lehnt einen Bildbeleg über 40 Megapixel mit verständlicher Meldung ab (400, kein 500), nichts wird angelegt', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  const kontoId = seedGrundlagen(db);
  const app = buildTestApp(db, createStubMailer());

  const res = await request(app)
    .post('/spesen')
    .set('x-test-person-id', '5')
    .field('_csrf', 'valid-token')
    .field('posKontoId', String(kontoId))
    .field('posBetrag', '61.75')
    .field('posAuslageDatum', '2026-08-20')
    .field('posBeschreibung', 'Bahnticket')
    .attach('posBeleg_0', buildPngHeaderOnly(14000, 14000), { filename: 'gross.png', contentType: 'image/png' });

  assert.equal(res.status, 400);
  assert.match(res.text, /Position 1: Das Bild ist zu gross/);
  assert.match(res.text, /40 Megapixel/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE quelle = 'spesen'").get().n, 0);
  db.close();
});

test('GET /spesen/neu nennt die Grössengrenzen für Belege (je Datei, Megapixel, gesamt)', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedGrundlagen(db);
  const app = buildTestApp(db, createStubMailer());
  const res = await request(app).get('/spesen/neu').set('x-test-person-id', '5');
  assert.equal(res.status, 200);
  assert.match(res.text, /Jede Datei darf höchstens 20 MB gross sein/);
  assert.match(res.text, /Bilder höchstens 40 Megapixel/);
  assert.match(res.text, /alle Belege zusammen höchstens 60 MB/);
  db.close();
});

// ---------------------------------------------------------------------------------------------
// B2, Etappe 2: Spesen-Belege werden im PDF-Worker geprüft und zu PDF + Vorschaubild verarbeitet.

async function spesenMitBelegen(app, belege) {
  let req = request(app).post('/spesen').set('x-test-person-id', '5').field('_csrf', 'valid-token');
  belege.forEach(({ kontoId }) => {
    req = req.field('posKontoId', String(kontoId)).field('posBetrag', '10.00').field('posAuslageDatum', '2026-08-20').field('posBeschreibung', 'Beleg');
  });
  belege.forEach(({ bytes, name, type }, i) => {
    req = req.attach(`posBeleg_${i}`, bytes, { filename: name, contentType: type });
  });
  return req;
}

function spesenSetupMitOrdner() {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  const kontoId = seedGrundlagen(db);
  const jobsDir = mkdtempSync(join(tmpdir(), 'spesen-b2-'));
  const app = buildTestApp(db, createStubMailer(), { ...testConfig(), jobsDir });
  return { db, kontoId, jobsDir, app, cleanup: () => { db.close(); rmSync(jobsDir, { recursive: true, force: true }); } };
}

test('B2: Zeitlimit beim Erstellen des zweiten Belegs → 503 mit Formular und Hinweis, kein Job, keine Abrechnung, keine Datei', async () => {
  const t = spesenSetupMitOrdner();
  try {
    const normal = await buildPdfFixture(['Beleg 1']);
    const langsam = Buffer.concat([await buildPdfFixture(['Beleg 2']), Buffer.from('\n%LANGSAM_ERSTELLEN\n')]);
    const res = await mitPdfStoerung('zeitlimit', () => spesenMitBelegen(t.app, [
      { kontoId: t.kontoId, bytes: normal, name: 'a.pdf', type: 'application/pdf' },
      { kontoId: t.kontoId, bytes: langsam, name: 'b.pdf', type: 'application/pdf' },
    ]));
    assert.equal(res.status, 503);
    assert.equal(res.headers['retry-after'], '60');
    assert.match(res.text, /in einer Minute erneut/);
    assert.match(res.text, /name="posBeschreibung"/, 'das Formular wird mit den Eingaben neu dargestellt');
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n, 0);
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM spesenabrechnungen').get().n, 0);
    assert.deepEqual(readdirSync(t.jobsDir), [], 'die Datei der ersten Position wird wieder entfernt');
  } finally {
    t.cleanup();
  }
});

test('B2: Zeitlimit bei der Eingangsprüfung eines PDF-Belegs → 503, kein Job, keine Datei', async () => {
  const t = spesenSetupMitOrdner();
  try {
    const langsam = Buffer.concat([await buildPdfFixture(['Beleg']), Buffer.from('\n%LANGSAM_PRUEFEN\n')]);
    const res = await mitPdfStoerung('zeitlimit', () => spesenMitBelegen(t.app, [{ kontoId: t.kontoId, bytes: langsam, name: 'a.pdf', type: 'application/pdf' }]));
    assert.equal(res.status, 503);
    assert.match(res.text, /in einer Minute erneut/);
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n, 0);
    assert.deepEqual(readdirSync(t.jobsDir), []);
  } finally {
    t.cleanup();
  }
});

test('B2: überlastete PDF-Verarbeitung beim Bildbeleg → 503, kein Job, keine Datei', async () => {
  const t = spesenSetupMitOrdner();
  try {
    const res = await mitPdfStoerung('ueberlastet', () => spesenMitBelegen(t.app, [{ kontoId: t.kontoId, bytes: PNG_1X1, name: 'foto.png', type: 'image/png' }]));
    assert.equal(res.status, 503);
    assert.match(res.text, /in einer Minute erneut/);
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n, 0);
    assert.deepEqual(readdirSync(t.jobsDir), []);
  } finally {
    t.cleanup();
  }
});

test('B2: Spesen im Worker-Betrieb – Bildbeleg wird PDF mit Vorschaubild; kaputtes PDF bleibt 400 mit derselben Meldung', async () => {
  const { PDF_EINGANG_MELDUNGEN } = await import('../../src/services/pdfFehler.js');
  const t = spesenSetupMitOrdner();
  try {
    const ok = await spesenMitBelegen(t.app, [{ kontoId: t.kontoId, bytes: PNG_1X1, name: 'foto.png', type: 'image/png' }]);
    assert.equal(ok.status, 302, ok.text);
    const job = t.db.prepare("SELECT * FROM jobs WHERE quelle = 'spesen'").get();
    assert.ok(readFileSync(job.pdf_pfad).subarray(0, 4).equals(Buffer.from('%PDF')));
    assert.ok(job.thumbnail_pfad && readFileSync(job.thumbnail_pfad).subarray(1, 4).equals(Buffer.from('PNG')));

    const kaputt = await spesenMitBelegen(t.app, [{ kontoId: t.kontoId, bytes: Buffer.from('%PDF-1.4\n%kaputt\n'), name: 'k.pdf', type: 'application/pdf' }]);
    assert.equal(kaputt.status, 400);
    assert.ok(kaputt.text.includes(`Position 1: ${PDF_EINGANG_MELDUNGEN.pdf_beschaedigt}`));
    assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE quelle = 'spesen'").get().n, 1);
  } finally {
    t.cleanup();
  }
});
