import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { seedDefaults, setConfigValue } from '../../src/db/adminConfigRepo.js';
import { createKreditkarte } from '../../src/db/kreditkartenRepo.js';
import { createKonto } from '../../src/db/kontenRepo.js';
import { createKkBeleg } from '../../src/db/kkBelegeRepo.js';
import { createJob, claimJob, getJobById, createSplitJob } from '../../src/db/jobsRepo.js';
import { listFreigabenByJob } from '../../src/db/freigabenRepo.js';
import { loadCurrentPerson, requireLogin } from '../../src/middleware/roles.js';
import { loadNavFlags } from '../../src/middleware/nav.js';
import { createKontierungRouter } from '../../src/routes/kontierung.js';
import { createKkAbgleichRouter } from '../../src/routes/kkAbgleich.js';
import { createPoolPageRouter } from '../../src/routes/poolPage.js';

const config = { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20' }, downloadSigningSecret: 's', jobsDir: '/tmp', publicBaseUrl: 'https://portal.example.org' };

function setup() {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  setConfigValue(db, 'modul_kreditkarten_aktiv', '1');
  upsertPerson(db, { id: '1', vorname: 'Buch', nachname: 'Haltung', email: 'b@example.org', gruppen: ['10'] });
  upsertPerson(db, { id: '2', vorname: 'Ver', nachname: 'Antwortlich', email: 'v@example.org', gruppen: [] });
  upsertPerson(db, { id: '9', vorname: 'Super', nachname: 'Admin', email: 'a@example.org', gruppen: ['20'] });
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
  app.use('/kontierung', requireLogin(), createKkAbgleichRouter({ db, config, mailer }));
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
  t.db.close();
});

test('POST /pool/:id/als-kk-abrechnung is 403 for a non-Buchhaltung person and 403 when the module is off', async () => {
  const t = setup();
  assert.equal((await request(t.app).post(`/pool/${t.jobId}/als-kk-abrechnung`).set('x-test-person-id', '2').type('form').send({ kreditkarteId: String(t.karteId) })).status, 403);
  setConfigValue(t.db, 'modul_kreditkarten_aktiv', '0');
  assert.equal((await request(t.app).post(`/pool/${t.jobId}/als-kk-abrechnung`).set('x-test-person-id', '1').type('form').send({ kreditkarteId: String(t.karteId) })).status, 403);
  assert.equal(getJobById(t.db, t.jobId).kreditkarte_id, null);
  t.db.close();
});

test('POST /kontierung/:id/als-kk-abrechnung from the Kontierung; self-marking by the responsible person sends no mail and redirects to the Abgleich', async () => {
  const t = setup();
  claimJob(t.db, t.jobId, '2');
  const res = await request(t.app).post(`/kontierung/${t.jobId}/als-kk-abrechnung`).set('x-test-person-id', '2').type('form').send({ kreditkarteId: String(t.karteId) });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, `/kontierung/${t.jobId}/kk-abgleich`);
  assert.equal(t.sent.length, 0);
  t.db.close();
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
  assert.equal((await request(t.app).post(`/kontierung/${t.jobId}/aufsplitten`).set('x-test-person-id', '2').field('gesamtbetrag', '10.00')).status, 409);
  assert.equal(getJobById(t.db, t.jobId).status, 'zugewiesen');
  t.db.close();
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
  t.db.close();
});

// hebeKkMarkierungAuf/sendJobBackToGroup can in principle both fail inside the transaction (a
// concurrent process unmarking or reassigning the same job) — the route must then roll back and
// 409 rather than log a kk_markierung_aufgehoben freigabe for an unmark that never happened. This
// synchronous single-process test can't force that exact interleaving (loadAuthorizedJob's own
// status/zugewiesen_an checks and the immediate !job.kreditkarte_id guard already rule out every
// state that would make either DB call's WHERE clause fail once execution reaches the
// transaction — see the route's own comments). It instead proves the same "no partial effect,
// no freigabe row" contract via the guard that IS reachable: directly clearing kreditkarte_id
// between marking and unmarking (simulating a concurrent kk-markierung-aufheben or kk-abgleich
// that already resolved it) makes the route's own not-marked check 409 before the transaction
// even starts, and no freigabe row is written.
test('POST /kontierung/:id/kk-markierung-aufheben is 409 (not a logged unmark) when the job is no longer marked by the time it runs', async () => {
  const t = setup();
  claimJob(t.db, t.jobId, '2');
  await request(t.app).post(`/kontierung/${t.jobId}/als-kk-abrechnung`).set('x-test-person-id', '2').type('form').send({ kreditkarteId: String(t.karteId) });
  t.db.prepare('UPDATE jobs SET kreditkarte_id = NULL WHERE id = ?').run(t.jobId);
  const vorFreigaben = listFreigabenByJob(t.db, t.jobId).length;
  const res = await request(t.app).post(`/kontierung/${t.jobId}/kk-markierung-aufheben`).set('x-test-person-id', '2').type('form').send({ bemerkung: 'zu spät' });
  assert.equal(res.status, 409);
  const job = getJobById(t.db, t.jobId);
  assert.equal(job.status, 'zugewiesen');
  assert.equal(listFreigabenByJob(t.db, t.jobId).length, vorFreigaben);
  assert.ok(!listFreigabenByJob(t.db, t.jobId).some((f) => f.rolle === 'kk_markierung_aufgehoben'));
  t.db.close();
});

test('POST /kontierung/:id/als-kk-abrechnung is 403 when the module is off and 400 for an invalid or inactive card', async () => {
  const t = setup();
  claimJob(t.db, t.jobId, '2');
  const inaktiv = createKreditkarte(t.db, { bezeichnung: 'Alt', verantwortlichId: '2', erfassungOffen: true });
  t.db.prepare('UPDATE kreditkarten SET aktiv = 0 WHERE id = ?').run(inaktiv);
  const markiere = (kreditkarteId) => request(t.app).post(`/kontierung/${t.jobId}/als-kk-abrechnung`).set('x-test-person-id', '2').type('form').send({ kreditkarteId });
  assert.equal((await markiere('999')).status, 400);
  assert.equal((await markiere(String(inaktiv))).status, 400);
  setConfigValue(t.db, 'modul_kreditkarten_aktiv', '0');
  assert.equal((await markiere(String(t.karteId))).status, 403);
  const job = getJobById(t.db, t.jobId);
  assert.equal(job.kreditkarte_id, null);
  assert.equal(job.zugewiesen_an, '2');
  t.db.close();
});

function legeSplitKindAn(t, { zugewiesenAn }) {
  const kontoId = createKonto(t.db, { kontonummer: '1000', bezeichnung: 'Eigen', freigeber1Id: '2', stellvertreter1Id: '1', freigeber2Id: '1', stellvertreter2Id: '9' });
  t.db.prepare("UPDATE jobs SET status = 'aufgesplittet' WHERE id = ?").run(t.jobId);
  return createSplitJob(t.db, getJobById(t.db, t.jobId), { pdfPfad: '/tmp/k.pdf', kontoId: zugewiesenAn ? kontoId : null, betrag: '5.00', zugewiesenAn });
}

test('a split child cannot be marked as a card statement: 409 from Kontierung and Pool, nothing changes, no marking form shown', async () => {
  const t = setup();
  const zugewiesen = legeSplitKindAn(t, { zugewiesenAn: '2' });
  const res = await request(t.app).post(`/kontierung/${zugewiesen}/als-kk-abrechnung`).set('x-test-person-id', '2').type('form').send({ kreditkarteId: String(t.karteId) });
  assert.equal(res.status, 409);
  assert.equal(getJobById(t.db, zugewiesen).kreditkarte_id, null);
  assert.equal(getJobById(t.db, zugewiesen).status, 'zugewiesen');
  const seite = await request(t.app).get(`/kontierung/${zugewiesen}`).set('x-test-person-id', '2');
  assert.equal(seite.status, 200);
  assert.doesNotMatch(seite.text, /als-kk-abrechnung/);

  const imPool = legeSplitKindAn(t, { zugewiesenAn: null });
  const poolRes = await request(t.app).post(`/pool/${imPool}/als-kk-abrechnung`).set('x-test-person-id', '1').type('form').send({ kreditkarteId: String(t.karteId) });
  assert.equal(poolRes.status, 409);
  assert.equal(getJobById(t.db, imPool).kreditkarte_id, null);
  assert.equal(getJobById(t.db, imPool).status, 'unzugewiesen');
  assert.equal(t.sent.length, 0);
  t.db.close();
});

test('the pool marking form lists only pool jobs that are not split children', async () => {
  const t = setup();
  const normal = createJob(t.db, { eingangAm: '2026-09-27T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'normal.pdf', pdfPfad: '/tmp/n.pdf' });
  const kind = legeSplitKindAn(t, { zugewiesenAn: null });
  const res = await request(t.app).get('/pool').set('x-test-person-id', '1');
  assert.equal(res.status, 200);
  const auswahl = /<select[^>]*id="kk-markieren-job"[^>]*>([\s\S]*?)<\/select>/.exec(res.text)[1];
  assert.match(auswahl, new RegExp(`value="${normal}"`));
  assert.doesNotMatch(auswahl, new RegExp(`value="${kind}"`));
  t.db.close();
});

test('marking an escalated job clears the escalation, so the responsible person can open their Abgleich', async () => {
  const t = setup();
  t.db.prepare("UPDATE jobs SET status = 'zugewiesen', zugewiesen_an = '1', freigabe1_eskaliert_von = '1', freigabe1_eskalationsgrund = 'Konflikt', freigabe1_eskaliert_an_admin = 1 WHERE id = ?").run(t.jobId);
  const res = await request(t.app).post(`/kontierung/${t.jobId}/als-kk-abrechnung`).set('x-test-person-id', '9').type('form').send({ kreditkarteId: String(t.karteId) });
  assert.equal(res.status, 302);
  const job = getJobById(t.db, t.jobId);
  assert.equal(job.zugewiesen_an, '2');
  assert.equal(job.freigabe1_eskaliert_von, null);
  assert.equal(job.freigabe1_eskalationsgrund, null);
  assert.equal(job.freigabe1_eskaliert_an_admin, 0);
  const abgleich = await request(t.app).get(`/kontierung/${t.jobId}/kk-abgleich`).set('x-test-person-id', '2');
  assert.equal(abgleich.status, 200);
  t.db.close();
});

test('a marked job cannot be put back into the pool or sent back to the group (409, still marked)', async () => {
  const t = setup();
  claimJob(t.db, t.jobId, '2');
  await request(t.app).post(`/kontierung/${t.jobId}/als-kk-abrechnung`).set('x-test-person-id', '2').type('form').send({ kreditkarteId: String(t.karteId) });
  assert.equal((await request(t.app).post(`/kontierung/${t.jobId}/zurueck-in-pool`).set('x-test-person-id', '2').type('form').send({})).status, 409);
  assert.equal((await request(t.app).post(`/kontierung/${t.jobId}/an-gruppe-zurueck`).set('x-test-person-id', '2').type('form').send({ bemerkung: 'falsch' })).status, 409);
  const job = getJobById(t.db, t.jobId);
  assert.equal(job.status, 'zugewiesen');
  assert.equal(job.zugewiesen_an, '2');
  assert.equal(job.kreditkarte_id, t.karteId);
  t.db.close();
});
