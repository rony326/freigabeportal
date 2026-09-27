import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { seedDefaults, setConfigValue } from '../../src/db/adminConfigRepo.js';
import { createKreditkarte } from '../../src/db/kreditkartenRepo.js';
import { createKkBeleg } from '../../src/db/kkBelegeRepo.js';
import { createJob, claimJob, getJobById } from '../../src/db/jobsRepo.js';
import { listFreigabenByJob } from '../../src/db/freigabenRepo.js';
import { loadCurrentPerson, requireLogin } from '../../src/middleware/roles.js';
import { loadNavFlags } from '../../src/middleware/nav.js';
import { createKontierungRouter } from '../../src/routes/kontierung.js';
import { createPoolPageRouter } from '../../src/routes/poolPage.js';

const config = { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20' }, downloadSigningSecret: 's', jobsDir: '/tmp', publicBaseUrl: 'https://portal.example.org' };

function setup() {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  setConfigValue(db, 'modul_kreditkarten_aktiv', '1');
  upsertPerson(db, { id: '1', vorname: 'Buch', nachname: 'Haltung', email: 'b@example.org', gruppen: ['10'] });
  upsertPerson(db, { id: '2', vorname: 'Ver', nachname: 'Antwortlich', email: 'v@example.org', gruppen: [] });
  const karteId = createKreditkarte(db, { bezeichnung: 'Visa Jugend', verantwortlichId: '2', erfassungOffen: true });
  createKkBeleg(db, { kreditkarteId: karteId, hochgeladenVon: '2', gekauftVon: '2', quelle: 'web', pdfPfad: '/tmp/x.pdf', betrag: '1.00', kaufdatum: '2026-09-01', beschreibung: 'x', status: 'offen' });
  const jobId = createJob(db, { eingangAm: '2026-09-27T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'abrechnung.pdf', pdfPfad: '/tmp/a.pdf' });
  const sent = [];
  const mailer = { async sendMail(m) { sent.push(m); } };
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', new URL('../../views', import.meta.url).pathname);
  app.use((req, res, next) => { res.locals.branding = { primaryColor: '#000', secondaryColor: '#fff', hasLogo: false, themeAttr: null }; next(); });
  app.use(express.urlencoded({ extended: false }));
  app.use((req, res, next) => { req.session = { personId: req.headers['x-test-person-id'] }; next(); });
  app.use(loadCurrentPerson(db));
  app.use(loadNavFlags(db, config));
  app.use('/kontierung', requireLogin(), createKontierungRouter({ db, config, mailer }));
  app.use('/pool', requireLogin(), createPoolPageRouter({ db, config, mailer }));
  return { db, app, karteId, jobId, sent };
}

test('POST /pool/:id/als-kk-abrechnung marks a pool job, assigns it to the responsible person, logs and mails', async () => {
  const t = setup();
  const res = await request(t.app).post(`/pool/${t.jobId}/als-kk-abrechnung`).set('x-test-person-id', '1').type('form').send({ kreditkarteId: String(t.karteId) });
  assert.equal(res.status, 302);
  const job = getJobById(t.db, t.jobId);
  assert.equal(job.status, 'zugewiesen');
  assert.equal(job.zugewiesen_an, '2');
  assert.equal(job.kreditkarte_id, t.karteId);
  const f = listFreigabenByJob(t.db, t.jobId);
  assert.equal(f.at(-1).rolle, 'kk_abrechnung_markiert');
  assert.equal(t.sent.length, 1);
  assert.equal(t.sent[0].to, 'v@example.org');
  assert.match(t.sent[0].text, /Visa Jugend/);
  assert.match(t.sent[0].text, /1 offene/);
});

test('POST /pool/:id/als-kk-abrechnung is 403 for a non-Buchhaltung person and 403 when the module is off', async () => {
  const t = setup();
  assert.equal((await request(t.app).post(`/pool/${t.jobId}/als-kk-abrechnung`).set('x-test-person-id', '2').type('form').send({ kreditkarteId: String(t.karteId) })).status, 403);
  setConfigValue(t.db, 'modul_kreditkarten_aktiv', '0');
  assert.equal((await request(t.app).post(`/pool/${t.jobId}/als-kk-abrechnung`).set('x-test-person-id', '1').type('form').send({ kreditkarteId: String(t.karteId) })).status, 403);
  assert.equal(getJobById(t.db, t.jobId).kreditkarte_id, null);
});

test('POST /kontierung/:id/als-kk-abrechnung from the Kontierung; self-marking by the responsible person sends no mail and redirects to the Abgleich', async () => {
  const t = setup();
  claimJob(t.db, t.jobId, '2');
  const res = await request(t.app).post(`/kontierung/${t.jobId}/als-kk-abrechnung`).set('x-test-person-id', '2').type('form').send({ kreditkarteId: String(t.karteId) });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, `/kontierung/${t.jobId}/kk-abgleich`);
  assert.equal(t.sent.length, 0);
});

test('a marked job: GET /kontierung/:id redirects to the Abgleich, Kontierung and Aufsplitten are 409', async () => {
  const t = setup();
  claimJob(t.db, t.jobId, '2');
  await request(t.app).post(`/kontierung/${t.jobId}/als-kk-abrechnung`).set('x-test-person-id', '2').type('form').send({ kreditkarteId: String(t.karteId) });
  const get = await request(t.app).get(`/kontierung/${t.jobId}`).set('x-test-person-id', '2');
  assert.equal(get.status, 302);
  assert.equal(get.headers.location, `/kontierung/${t.jobId}/kk-abgleich`);
  assert.equal((await request(t.app).post(`/kontierung/${t.jobId}`).set('x-test-person-id', '2').field('aktion', 'kontieren')).status, 409);
  assert.equal((await request(t.app).get(`/kontierung/${t.jobId}/aufsplitten`).set('x-test-person-id', '2')).status, 409);
});

test('POST /kontierung/:id/kk-markierung-aufheben needs a remark, then sends the job back to the pool unmarked', async () => {
  const t = setup();
  claimJob(t.db, t.jobId, '2');
  await request(t.app).post(`/kontierung/${t.jobId}/als-kk-abrechnung`).set('x-test-person-id', '2').type('form').send({ kreditkarteId: String(t.karteId) });
  assert.equal((await request(t.app).post(`/kontierung/${t.jobId}/kk-markierung-aufheben`).set('x-test-person-id', '2').type('form').send({ bemerkung: '' })).status, 400);
  const res = await request(t.app).post(`/kontierung/${t.jobId}/kk-markierung-aufheben`).set('x-test-person-id', '2').type('form').send({ bemerkung: 'Ist die Mastercard' });
  assert.equal(res.status, 302);
  const job = getJobById(t.db, t.jobId);
  assert.equal(job.status, 'unzugewiesen');
  assert.equal(job.kreditkarte_id, null);
  assert.equal(job.pool_rueckgesendet_bemerkung, 'Ist die Mastercard');
  assert.ok(listFreigabenByJob(t.db, t.jobId).some((f) => f.rolle === 'kk_markierung_aufgehoben'));
});
