import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createKonto } from '../../src/db/kontenRepo.js';
import { createSpesenabrechnung } from '../../src/db/spesenabrechnungenRepo.js';
import { createSpesenPosition, getJobById } from '../../src/db/jobsRepo.js';
import { loadCurrentPerson, requireLogin } from '../../src/middleware/roles.js';
import { loadNavFlags } from '../../src/middleware/nav.js';
import { createSpesenFreigabe1Router } from '../../src/routes/spesenFreigabe1.js';

function createStubMailer() {
  const sent = [];
  return { sent, async sendMail(mail) { sent.push(mail); } };
}

function testConfig() {
  return { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20' }, downloadSigningSecret: 'test-secret', publicBaseUrl: 'https://portal.example.org' };
}

function buildTestApp(db, mailer, config = testConfig()) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', new URL('../../views', import.meta.url).pathname);
  app.use(express.urlencoded({ extended: false }));
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
  app.use('/spesen-freigabe1', requireLogin(), createSpesenFreigabe1Router({ db, config, mailer, csrfProtection }));
  return app;
}

function seedGrundlagen(db) {
  upsertPerson(db, { id: '1', vorname: 'Frei', nachname: 'Geber1', email: 'f1@example.org', gruppen: ['20'] });
  upsertPerson(db, { id: '2', vorname: 'Stell', nachname: 'Vertreter1', email: 's1@example.org', gruppen: [] });
  upsertPerson(db, { id: '3', vorname: 'Frei', nachname: 'Geber2', email: 'f2@example.org', gruppen: [] });
  upsertPerson(db, { id: '4', vorname: 'Stell', nachname: 'Vertreter2', email: 's2@example.org', gruppen: [] });
  upsertPerson(db, { id: '5', vorname: 'Ein', nachname: 'Reicher', email: 'e@example.org', gruppen: [] });
  const kontoId = createKonto(db, { kontonummer: '1000', bezeichnung: 'Reisespesen', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  const spesenabrechnungId = createSpesenabrechnung(db, { eingereichtVon: '5', eingereichtAm: '2026-08-31T08:00:00.000Z', titel: null });
  const jobId = createSpesenPosition(db, {
    eingangAm: '2026-08-31T08:00:00.000Z', eingereichtVon: '5', kontoId, betrag: '61.75', auslageDatum: '2026-08-20',
    beschreibung: 'Bahnticket', dateiname: 'ticket.pdf', pdfPfad: '/tmp/ticket.pdf', thumbnailPfad: null, spesenabrechnungId,
    zugewiesenAn: '1', freigabe1EskaliertVon: null, freigabe1Eskalationsgrund: null,
  });
  return { kontoId, jobId };
}

test('GET /spesen-freigabe1/:id 403s for someone the job is not assigned to', async () => {
  const db = openDatabase(':memory:');
  const { jobId } = seedGrundlagen(db);
  const app = buildTestApp(db, createStubMailer());
  const res = await request(app).get(`/spesen-freigabe1/${jobId}`).set('x-test-person-id', '5');
  assert.equal(res.status, 403);
  db.close();
});

test('GET /spesen-freigabe1/:id 200s and shows Beschreibung/Auslage-Datum/Eingereicht-von for the assigned Freigeber1', async () => {
  const db = openDatabase(':memory:');
  const { jobId } = seedGrundlagen(db);
  const app = buildTestApp(db, createStubMailer());
  const res = await request(app).get(`/spesen-freigabe1/${jobId}`).set('x-test-person-id', '1');
  assert.equal(res.status, 200);
  assert.match(res.text, /Bahnticket/);
  assert.match(res.text, /2026-08-20/);
  assert.match(res.text, /Ein Reicher/);
  assert.doesNotMatch(res.text, /<strong>Titel:<\/strong>/, 'no Titel line when the Spesenabrechnung has none');
  db.close();
});

test('GET /spesen-freigabe1/:id shows the Spesenabrechnung Titel when one was given at submission', async () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'Frei', nachname: 'Geber1', email: 'f1@example.org', gruppen: ['20'] });
  upsertPerson(db, { id: '5', vorname: 'Ein', nachname: 'Reicher', email: 'e@example.org', gruppen: [] });
  const kontoId = createKonto(db, { kontonummer: '1000', bezeichnung: 'Reisespesen', freigeber1Id: '1', stellvertreter1Id: '1', freigeber2Id: '1', stellvertreter2Id: '1' });
  const spesenabrechnungId = createSpesenabrechnung(db, { eingereichtVon: '5', eingereichtAm: '2026-08-31T08:00:00.000Z', titel: 'Reise Zürich 12.–14.8.' });
  const jobId = createSpesenPosition(db, {
    eingangAm: '2026-08-31T08:00:00.000Z', eingereichtVon: '5', kontoId, betrag: '61.75', auslageDatum: '2026-08-20',
    beschreibung: 'Bahnticket', dateiname: 'ticket.pdf', pdfPfad: '/tmp/ticket.pdf', thumbnailPfad: null, spesenabrechnungId,
    zugewiesenAn: '1', freigabe1EskaliertVon: null, freigabe1Eskalationsgrund: null,
  });
  const app = buildTestApp(db, createStubMailer());
  const res = await request(app).get(`/spesen-freigabe1/${jobId}`).set('x-test-person-id', '1');
  assert.equal(res.status, 200);
  assert.match(res.text, /<strong>Titel:<\/strong> Reise Zürich 12.–14.8./);
  db.close();
});

test('POST /spesen-freigabe1/:id freigeben (no conflict) moves the job to freigabe2 and notifies Freigeber2', async () => {
  const db = openDatabase(':memory:');
  const { jobId } = seedGrundlagen(db);
  const mailer = createStubMailer();
  const app = buildTestApp(db, mailer);

  const res = await request(app)
    .post(`/spesen-freigabe1/${jobId}`)
    .set('x-test-person-id', '1')
    .type('form')
    .send({ _csrf: 'valid-token', interessenskonflikt: 'nein', aktion: 'freigeben' });

  assert.equal(res.status, 302);
  const job = getJobById(db, jobId);
  assert.equal(job.status, 'freigabe2');
  assert.equal(mailer.sent[0].to, 'f2@example.org');
  db.close();
});

test('POST /spesen-freigabe1/:id ablehnen sets status abgelehnt and notifies the submitter', async () => {
  const db = openDatabase(':memory:');
  const { jobId } = seedGrundlagen(db);
  const mailer = createStubMailer();
  const app = buildTestApp(db, mailer);

  const res = await request(app)
    .post(`/spesen-freigabe1/${jobId}`)
    .set('x-test-person-id', '1')
    .type('form')
    .send({ _csrf: 'valid-token', aktion: 'ablehnen', begruendung: 'Kein Beleg lesbar' });

  assert.equal(res.status, 302);
  const job = getJobById(db, jobId);
  assert.equal(job.status, 'abgelehnt');
  assert.equal(job.ablehnungsgrund, 'Kein Beleg lesbar');
  assert.equal(mailer.sent[0].to, 'e@example.org');
  db.close();
});

test('POST /spesen-freigabe1/:id with a declared Interessenskonflikt escalates to Stellvertreter1', async () => {
  const db = openDatabase(':memory:');
  const { jobId } = seedGrundlagen(db);
  const mailer = createStubMailer();
  const app = buildTestApp(db, mailer);

  const res = await request(app)
    .post(`/spesen-freigabe1/${jobId}`)
    .set('x-test-person-id', '1')
    .type('form')
    .send({ _csrf: 'valid-token', interessenskonflikt: 'ja', begruendung: 'Verwandt mit der einreichenden Person', aktion: 'freigeben' });

  assert.equal(res.status, 302);
  const job = getJobById(db, jobId);
  assert.equal(job.status, 'zugewiesen', 'must stay open, not auto-approve');
  assert.equal(job.zugewiesen_an, '2');
  assert.equal(job.freigabe1_eskaliert_von, '1');
  assert.equal(mailer.sent[0].to, 's1@example.org');
  db.close();
});

test('GET /spesen-freigabe1/:id 403s the submitter even once the job is admin-escalated and they happen to be a superadmin themselves', async () => {
  const db = openDatabase(':memory:');
  // Person 1 is both this Konto's own Freigeber1 AND in the admin group ('20') — the exact
  // combination that lets a self-submitted claim reach the admin-escalated branch (submitter is
  // Freigeber1 -> auto-escalates to Stellvertreter1 at submission -> Stellvertreter1 also
  // declares a conflict -> since freigabe1_eskaliert_von is already set, that second conflict
  // routes straight to the admin group) while the submitter is also authorized to act on
  // admin-escalated jobs in general.
  upsertPerson(db, { id: '1', vorname: 'Frei', nachname: 'Geber1', email: 'f1@example.org', gruppen: ['20'] });
  upsertPerson(db, { id: '2', vorname: 'Stell', nachname: 'Vertreter1', email: 's1@example.org', gruppen: [] });
  upsertPerson(db, { id: '3', vorname: 'Frei', nachname: 'Geber2', email: 'f2@example.org', gruppen: [] });
  upsertPerson(db, { id: '4', vorname: 'Stell', nachname: 'Vertreter2', email: 's2@example.org', gruppen: [] });
  upsertPerson(db, { id: '6', vorname: 'Ander', nachname: 'SuperAdmin', email: 'admin6@example.org', gruppen: ['20'] });
  const kontoId = createKonto(db, { kontonummer: '1000', bezeichnung: 'Reisespesen', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  const spesenabrechnungId = createSpesenabrechnung(db, { eingereichtVon: '1', eingereichtAm: '2026-08-31T08:00:00.000Z', titel: null });
  // Mirrors what POST /spesen actually persists for a self-submitted Freigeber1: zugewiesenAn is
  // the Stellvertreter1, freigabe1_eskaliert_von is already the submitter.
  const jobId = createSpesenPosition(db, {
    eingangAm: '2026-08-31T08:00:00.000Z', eingereichtVon: '1', kontoId, betrag: '10.00', auslageDatum: '2026-08-20',
    beschreibung: 'Parkgebühr', dateiname: 'beleg.pdf', pdfPfad: '/tmp/beleg.pdf', thumbnailPfad: null, spesenabrechnungId,
    zugewiesenAn: '2', freigabe1EskaliertVon: '1', freigabe1Eskalationsgrund: 'Selbsteinreichung durch Freigeber1',
  });
  const mailer = createStubMailer();
  const app = buildTestApp(db, mailer);

  // Stellvertreter1 declares their own conflict -> routes to the admin group (freigabe1_eskaliert_von
  // is already set from submission time).
  const eskalationRes = await request(app)
    .post(`/spesen-freigabe1/${jobId}`)
    .set('x-test-person-id', '2')
    .type('form')
    .send({ _csrf: 'valid-token', interessenskonflikt: 'ja', begruendung: 'auch befangen', aktion: 'freigeben' });
  assert.equal(eskalationRes.status, 302);
  assert.equal(getJobById(db, jobId).freigabe1_eskaliert_an_admin, 1);

  const submitterRes = await request(app).get(`/spesen-freigabe1/${jobId}`).set('x-test-person-id', '1');
  assert.equal(submitterRes.status, 403, 'the submitter must never approve their own claim, even as a superadmin acting on an admin-escalated job');

  const otherAdminGetRes = await request(app).get(`/spesen-freigabe1/${jobId}`).set('x-test-person-id', '6');
  assert.equal(otherAdminGetRes.status, 200, 'a different superadmin can still access the admin-escalated job normally');

  const otherAdminPostRes = await request(app)
    .post(`/spesen-freigabe1/${jobId}`)
    .set('x-test-person-id', '6')
    .type('form')
    .send({ _csrf: 'valid-token', interessenskonflikt: 'nein', begruendung: '', aktion: 'freigeben' });
  assert.equal(otherAdminPostRes.status, 302);
  assert.equal(getJobById(db, jobId).status, 'freigabe2', 'a different superadmin can still act on the admin-escalated job normally');
  db.close();
});

test('POST /spesen-freigabe1/:id escalates to the admin group when the Stellvertreter1 also declares a conflict', async () => {
  const db = openDatabase(':memory:');
  const { jobId } = seedGrundlagen(db);
  const mailer = createStubMailer();
  const app = buildTestApp(db, mailer);

  await request(app)
    .post(`/spesen-freigabe1/${jobId}`)
    .set('x-test-person-id', '1')
    .type('form')
    .send({ _csrf: 'valid-token', interessenskonflikt: 'ja', begruendung: 'erster Konflikt', aktion: 'freigeben' });

  const res = await request(app)
    .post(`/spesen-freigabe1/${jobId}`)
    .set('x-test-person-id', '2')
    .type('form')
    .send({ _csrf: 'valid-token', interessenskonflikt: 'ja', begruendung: 'auch befangen', aktion: 'freigeben' });

  assert.equal(res.status, 302);
  const job = getJobById(db, jobId);
  assert.equal(job.freigabe1_eskaliert_an_admin, 1);
  assert.equal(mailer.sent.at(-1).to, 'f1@example.org', 'admin group resolves to person 1, the only seeded member of group 20');
  db.close();
});
