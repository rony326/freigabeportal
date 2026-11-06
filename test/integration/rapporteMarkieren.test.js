import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson, markUnresolved } from '../../src/db/personenRepo.js';
import { seedDefaults, setConfigValue } from '../../src/db/adminConfigRepo.js';
import { createJob, claimJob, getJobById } from '../../src/db/jobsRepo.js';
import { createKreditkarte } from '../../src/db/kreditkartenRepo.js';
import { listFreigabenByJob } from '../../src/db/freigabenRepo.js';
import { listKenntnisnahmen, bestaetigeKenntnisnahme } from '../../src/db/rapporteRepo.js';
import { loadCurrentPerson, requireLogin } from '../../src/middleware/roles.js';
import { loadNavFlags } from '../../src/middleware/nav.js';
import { markiereRapport } from '../../src/services/rapporte.js';
import { createKontierungRouter } from '../../src/routes/kontierung.js';
import { createPoolPageRouter } from '../../src/routes/poolPage.js';

const config = { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20', groupIdManager: '30' }, downloadSigningSecret: 's', jobsDir: '/tmp', publicBaseUrl: 'https://portal.example.org' };

function setup({ modul = true } = {}) {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  if (modul) setConfigValue(db, 'modul_rapporte_aktiv', '1');
  upsertPerson(db, { id: '1', vorname: 'Buch', nachname: 'Haltung', email: 'b@example.org', gruppen: ['10'] });
  upsertPerson(db, { id: '2', vorname: 'Anna', nachname: 'Empfang', email: 'e1@example.org', gruppen: [] });
  upsertPerson(db, { id: '3', vorname: 'Bruno', nachname: 'Empfang', email: 'e2@example.org', gruppen: [] });
  upsertPerson(db, { id: '4', vorname: 'Buch', nachname: 'Zwei', email: 'b2@example.org', gruppen: ['10'] });
  upsertPerson(db, { id: '9', vorname: 'Super', nachname: 'Admin', email: 'a@example.org', gruppen: ['20'] });
  const jobId = createJob(db, { eingangAm: '2026-11-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'rapport.pdf', pdfPfad: '/tmp/r.pdf' });
  claimJob(db, jobId, '1');
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
  return { db, app, jobId, sent };
}

const markiere = (t, id, body, person = '1') =>
  request(t.app).post(`/kontierung/${id}`).set('x-test-person-id', person).type('form').send({ aktion: 'rapport', ...body });

test('Modul aus: Radio fehlt im Formular und POST aktion=rapport → 409, Job unverändert', async () => {
  const t = setup({ modul: false });
  const get = await request(t.app).get(`/kontierung/${t.jobId}`).set('x-test-person-id', '1');
  assert.equal(get.status, 200);
  assert.doesNotMatch(get.text, /typRapport/);
  const res = await markiere(t, t.jobId, { empfaengerIds: ['2'] });
  assert.equal(res.status, 409);
  assert.equal(getJobById(t.db, t.jobId).status, 'zugewiesen');
  t.db.close();
});

test('Modul an: Radio im Formular, Kandidatenliste ohne unresolved', async () => {
  const t = setup();
  markUnresolved(t.db, '3');
  const get = await request(t.app).get(`/kontierung/${t.jobId}`).set('x-test-person-id', '1');
  assert.match(get.text, /typRapport/);
  assert.match(get.text, /Anna Empfang|Empfang Anna/);
  assert.doesNotMatch(get.text, /e2@example\.org|Bruno Empfang/);
  t.db.close();
});

test('nach dem Markieren fehlt der Rapport in der Kontierungsliste des Markierers', async () => {
  const t = setup();
  const vorher = t.db.prepare("SELECT id FROM jobs WHERE status = 'zugewiesen' AND zugewiesen_an = '1'").all().map((r) => r.id);
  assert.deepEqual(vorher, [t.jobId], 'Testaufbau: Job liegt vor dem Markieren in der Kontierung');
  const pool = express();
  pool.set('view engine', 'ejs');
  pool.set('views', new URL('../../views', import.meta.url).pathname);
  pool.use((req, res, next) => { res.locals.branding = { primaryColor: '#000', secondaryColor: '#fff', hasLogo: false, themeAttr: null }; next(); });
  pool.use((req, res, next) => { req.session = { personId: req.headers['x-test-person-id'] }; next(); });
  pool.use(loadCurrentPerson(t.db));
  pool.use(loadNavFlags(t.db, config));
  pool.use('/pool', requireLogin(), createPoolPageRouter({ db: t.db, config }));
  const davor = await request(pool).get('/pool').set('x-test-person-id', '1');
  assert.match(davor.text, /rapport\.pdf/, 'Testaufbau: vor dem Markieren steht der Job in der Kontierungsliste');
  assert.equal((await markiere(t, t.jobId, { empfaengerIds: ['2'] })).status, 302);
  const res = await request(pool).get('/pool').set('x-test-person-id', '1');
  assert.equal(res.status, 200);
  assert.doesNotMatch(res.text, /rapport\.pdf/);
  assert.doesNotMatch(res.text, new RegExp(`/kontierung/${t.jobId}\\b`));
  t.db.close();
});

test('Modul an: POST mit 2 Empfängern → kenntnisnahme, 2 Zeilen, 2 Mails, freigaben rapport_markiert', async () => {
  const t = setup();
  const res = await markiere(t, t.jobId, { empfaengerIds: ['2', '3'], bemerkung: 'Bitte lesen' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/pool');
  const job = getJobById(t.db, t.jobId);
  assert.equal(job.status, 'kenntnisnahme');
  assert.equal(job.typ, 'rapport');
  assert.equal(listKenntnisnahmen(t.db, t.jobId).length, 2);
  const f = listFreigabenByJob(t.db, t.jobId).at(-1);
  assert.equal(f.rolle, 'rapport_markiert');
  const mails = t.db.prepare("SELECT * FROM mail_log WHERE typ = 'rapport-zuweisung' ORDER BY id").all();
  assert.equal(mails.length, 2);
  assert.deepEqual(mails.map((m) => m.empfaenger ?? m.to_adresse).sort(), ['e1@example.org', 'e2@example.org']);
  assert.match(mails[0].text ?? mails[0].body ?? JSON.stringify(mails[0]), /\/rapporte\//);
  t.db.close();
});

test('ohne Empfänger → 400 mit Fehlermeldung, Job bleibt zugewiesen', async () => {
  const t = setup();
  const res = await markiere(t, t.jobId, {});
  assert.equal(res.status, 400);
  assert.match(res.text, /Empfänger/);
  assert.equal(getJobById(t.db, t.jobId).status, 'zugewiesen');
  const res2 = await markiere(t, t.jobId, { empfaengerIds: ['999'] });
  assert.equal(res2.status, 400);
  t.db.close();
});

test('Konto/Betrag im selben POST werden ignoriert (konto_id bleibt NULL)', async () => {
  const t = setup();
  const res = await markiere(t, t.jobId, { empfaengerIds: '2', kontoId: '1', betrag: '99.00', rechnungsnummer: 'X' });
  assert.equal(res.status, 302);
  const job = getJobById(t.db, t.jobId);
  assert.equal(job.konto_id, null);
  assert.equal(job.betrag, null);
  t.db.close();
});

test('Spesen-, Kreditkarten- und Splitkind-Job → 409', async () => {
  const t = setup();
  t.db.prepare("UPDATE jobs SET quelle = 'spesen' WHERE id = ?").run(t.jobId);
  // Route: die bestehende Kontierungs-Autorisierung weist Spesen schon mit 403 ab ...
  assert.equal((await markiere(t, t.jobId, { empfaengerIds: ['2'] })).status, 403);
  // ... der Service selbst lehnt sie zusätzlich mit 409 ab.
  const direkt = await markiereRapport(t.db, config, { async sendMail() {} }, { job: getJobById(t.db, t.jobId), person: { churchtools_person_id: '1', vorname: 'B', nachname: 'H' }, empfaengerIds: ['2'], bemerkung: '', ip: '' });
  assert.equal(direkt.status, 409);
  assert.equal(getJobById(t.db, t.jobId).status, 'zugewiesen');
  t.db.prepare("UPDATE jobs SET quelle = 'scanner', kreditkarte_id = NULL WHERE id = ?").run(t.jobId);

  const j2 = createJob(t.db, { eingangAm: '2026-11-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'kind.pdf', pdfPfad: '/tmp/k.pdf' });
  claimJob(t.db, j2, '1');
  t.db.prepare('UPDATE jobs SET aufgesplittet_von = ? WHERE id = ?').run(t.jobId, j2);
  assert.equal((await markiere(t, j2, { empfaengerIds: ['2'] })).status, 409);

  // Elternjob mit Kindern (Status wieder zugewiesen simuliert)
  assert.equal((await markiere(t, t.jobId, { empfaengerIds: ['2'] })).status, 409);

  const j3 = createJob(t.db, { eingangAm: '2026-11-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'kk.pdf', pdfPfad: '/tmp/kk.pdf' });
  claimJob(t.db, j3, '1');
  const karteId = createKreditkarte(t.db, { bezeichnung: 'V', verantwortlichId: '2', erfassungOffen: true });
  t.db.prepare('UPDATE jobs SET kreditkarte_id = ? WHERE id = ?').run(karteId, j3);
  assert.equal((await markiere(t, j3, { empfaengerIds: ['2'] })).status, 409);
  assert.equal(getJobById(t.db, j3).status, 'zugewiesen');
  t.db.close();
});

test('fremde Person (nicht zugewiesen) → 403 wie bei Kontierung', async () => {
  const t = setup();
  const res = await markiere(t, t.jobId, { empfaengerIds: ['2'] }, '4');
  assert.equal(res.status, 403);
  assert.equal(getJobById(t.db, t.jobId).status, 'zugewiesen');
  t.db.close();
});

test('aufheben vor erster Bestätigung → zugewiesen an Markierer; nach Bestätigung → 409', async () => {
  const t = setup();
  await markiere(t, t.jobId, { empfaengerIds: ['2', '3'] });
  const res = await request(t.app).post(`/kontierung/${t.jobId}/rapport-aufheben`).set('x-test-person-id', '1').type('form').send({});
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, `/kontierung/${t.jobId}`);
  const job = getJobById(t.db, t.jobId);
  assert.equal(job.status, 'zugewiesen');
  assert.equal(job.zugewiesen_an, '1');
  assert.equal(listFreigabenByJob(t.db, t.jobId).at(-1).rolle, 'rapport_markierung_aufgehoben');

  await markiere(t, t.jobId, { empfaengerIds: ['2', '3'] });
  bestaetigeKenntnisnahme(t.db, t.jobId, '2', new Date().toISOString());
  const res2 = await request(t.app).post(`/kontierung/${t.jobId}/rapport-aufheben`).set('x-test-person-id', '1').type('form').send({});
  assert.equal(res2.status, 409);
  assert.equal(getJobById(t.db, t.jobId).status, 'kenntnisnahme');
  t.db.close();
});

test('aufheben durch Dritten ohne workflow_eingreifen → 403, mit Recht → ok', async () => {
  const t = setup();
  await markiere(t, t.jobId, { empfaengerIds: ['2'] });
  const res = await request(t.app).post(`/kontierung/${t.jobId}/rapport-aufheben`).set('x-test-person-id', '4').type('form').send({});
  assert.equal(res.status, 403);
  assert.equal(getJobById(t.db, t.jobId).status, 'kenntnisnahme');
  const res2 = await request(t.app).post(`/kontierung/${t.jobId}/rapport-aufheben`).set('x-test-person-id', '9').type('form').send({});
  assert.equal(res2.status, 302);
  assert.equal(getJobById(t.db, t.jobId).status, 'zugewiesen');
  t.db.close();
});
