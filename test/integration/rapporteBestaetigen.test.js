import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import * as mupdf from 'mupdf';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson, setFerienmodus } from '../../src/db/personenRepo.js';
import { seedDefaults, setConfigValue } from '../../src/db/adminConfigRepo.js';
import { createJob, claimJob, getJobById } from '../../src/db/jobsRepo.js';
import { listFreigabenByJob } from '../../src/db/freigabenRepo.js';
import { listKenntnisnahmen, entferneEmpfaenger } from '../../src/db/rapporteRepo.js';
import { loadCurrentPerson, requireLogin } from '../../src/middleware/roles.js';
import { loadNavFlags } from '../../src/middleware/nav.js';
import { markiereRapport, finalisiereRapport } from '../../src/services/rapporte.js';
import { createRapporteRouter } from '../../src/routes/rapporte.js';
import { createPoolPageRouter } from '../../src/routes/poolPage.js';
import { createMeineAbgeschlossenenRouter } from '../../src/routes/meineAbgeschlossenen.js';
import { createKommentareRouter } from '../../src/routes/kommentare.js';
import { createKontierungRouter } from '../../src/routes/kontierung.js';
import { buildPdfFixture } from '../helpers/pdfFixture.js';
import { setupMockTsa, signedTsaResponse } from '../helpers/mockTsa.js';

const BASIS_CONFIG = {
  churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20', groupIdManager: '30' },
  downloadSigningSecret: 's',
  publicBaseUrl: 'https://portal.example.org',
  tsaTrustRequired: false,
};

const B = (id, vorname, nachname, gruppen = []) => ({ id, vorname, nachname, email: `${id}@example.org`, gruppen });

async function setup(t, { empfaenger = ['2', '3'] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rapporte-bestaetigen-'));
  const db = openDatabase(':memory:');
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  seedDefaults(db);
  setConfigValue(db, 'modul_rapporte_aktiv', '1');
  setConfigValue(db, 'zeitstempel_tsa_url', '');
  for (const p of [B('1', 'Buch', 'Haltung', ['10']), B('2', 'Anna', 'Empfang'), B('3', 'Bruno', 'Empfang'), B('5', 'Vera', 'Vertretung'), B('6', 'Fritz', 'Fremd'), B('9', 'Super', 'Admin', ['20'])]) {
    upsertPerson(db, p);
  }
  const config = { ...BASIS_CONFIG, jobsDir: dir };
  const pdfPfad = join(dir, 'rapport.pdf');
  writeFileSync(pdfPfad, await buildPdfFixture(['Rapport Seite 1']));
  const jobId = createJob(db, { eingangAm: '2026-11-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'rapport.pdf', pdfPfad });
  claimJob(db, jobId, '1');
  const mailer = { async sendMail() {} };
  const markierer = { churchtools_person_id: '1', vorname: 'Buch', nachname: 'Haltung' };
  const ergebnis = await markiereRapport(db, config, mailer, { job: getJobById(db, jobId), person: markierer, empfaengerIds: empfaenger, bemerkung: 'Bitte lesen', ip: '' });
  assert.equal(ergebnis.ok, true);

  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', new URL('../../views', import.meta.url).pathname);
  app.use((req, res, next) => { res.locals.branding = { primaryColor: '#000', secondaryColor: '#fff', hasLogo: false, themeAttr: null }; next(); });
  app.use(express.urlencoded({ extended: false }));
  app.use((req, res, next) => { req.session = { personId: req.headers['x-test-person-id'] }; next(); });
  app.use(loadCurrentPerson(db));
  app.use(loadNavFlags(db, config));
  app.use('/rapporte', requireLogin(), createRapporteRouter({ db, config, mailer }));
  app.use('/pool', requireLogin(), createPoolPageRouter({ db, config, mailer }));
  app.use('/meine-abgeschlossenen', requireLogin(), createMeineAbgeschlossenenRouter({ db, config }));
  app.use('/kommentare', requireLogin(), createKommentareRouter({ db, config, mailer }));
  app.use('/kontierung', requireLogin(), createKontierungRouter({ db, config, mailer }));
  return { db, app, jobId, dir, config };
}

const bestaetige = (t, person) => request(t.app).post(`/rapporte/${t.jobId}/bestaetigen`).set('x-test-person-id', person).type('form').send({});
const finalDateien = (dir) => readdirSync(dir).filter((f) => /^final-.*\.pdf$/.test(f));

function letzteSeite(pfad) {
  const doc = mupdf.Document.openDocument(readFileSync(pfad), 'application/pdf');
  try {
    const page = doc.loadPage(doc.countPages() - 1);
    try { return page.toStructuredText().asText(); } finally { page.destroy(); }
  } finally { doc.destroy(); }
}

test('Empfänger sieht Rapport im Pool-Abschnitt "Zur Kenntnis" und Badge zählt +1', async (t) => {
  const s = await setup(t);
  const pool = await request(s.app).get('/pool').set('x-test-person-id', '2');
  assert.equal(pool.status, 200);
  assert.match(pool.text, /Zur Kenntnis/);
  assert.match(pool.text, new RegExp(`id="rapport-row-${s.jobId}"`));
  assert.match(pool.text, new RegExp(`id="rapport-kachel-${s.jobId}"`));
  assert.match(pool.text, new RegExp(`href="/rapporte/${s.jobId}"`));
  assert.match(pool.text, /portal-zaehler">1</);
  const fremd = await request(s.app).get('/pool').set('x-test-person-id', '6');
  assert.doesNotMatch(fremd.text, /Zur Kenntnis/);

  const seite = await request(s.app).get(`/rapporte/${s.jobId}`).set('x-test-person-id', '2');
  assert.equal(seite.status, 200);
  assert.match(seite.text, /Bitte lesen/);
  assert.match(seite.text, /Zur Kenntnis genommen<\/button>/);
  assert.match(seite.text, /name="_csrf"/);
  assert.match(seite.text, /0 von 2/);
});

test('Zugriff: Unbeteiligte 403, Markierer/Superadmin sehen die Seite ohne Knopf, Nicht-Rapport 404', async (t) => {
  const s = await setup(t);
  assert.equal((await request(s.app).get(`/rapporte/${s.jobId}`).set('x-test-person-id', '6')).status, 403);
  for (const person of ['1', '9']) {
    const res = await request(s.app).get(`/rapporte/${s.jobId}`).set('x-test-person-id', person);
    assert.equal(res.status, 200, person);
    assert.doesNotMatch(res.text, /Zur Kenntnis genommen<\/button>/);
  }
  assert.equal((await request(s.app).get('/rapporte/99999').set('x-test-person-id', '9')).status, 404);
  assert.equal((await request(s.app).get('/rapporte/abc').set('x-test-person-id', '9')).status, 404);
});

test('Stellvertretung im Ferienmodus sieht keinen Knopf und POST → 403', async (t) => {
  const s = await setup(t);
  setFerienmodus(s.db, '2', { von: '2000-01-01', bis: '2999-01-01', stellvertreterId: '5' });
  const seite = await request(s.app).get(`/rapporte/${s.jobId}`).set('x-test-person-id', '5');
  assert.doesNotMatch(seite.text, /Zur Kenntnis genommen<\/button>/);
  const res = await bestaetige(s, '5');
  assert.equal(res.status, 403);
  assert.equal(listKenntnisnahmen(s.db, s.jobId).filter((k) => k.bestaetigt_am).length, 0);
});

test('erste von zwei Bestätigungen: status bleibt kenntnisnahme, Seite zeigt "1 von 2"', async (t) => {
  const s = await setup(t);
  const res = await bestaetige(s, '2');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, `/rapporte/${s.jobId}`);
  assert.equal(getJobById(s.db, s.jobId).status, 'kenntnisnahme');
  assert.equal(listFreigabenByJob(s.db, s.jobId).at(-1).rolle, 'rapport_bestaetigt');
  const seite = await request(s.app).get(`/rapporte/${s.jobId}`).set('x-test-person-id', '2');
  assert.match(seite.text, /1 von 2/);
  assert.doesNotMatch(seite.text, /Zur Kenntnis genommen<\/button>/, 'nach der eigenen Bestätigung kein Knopf mehr');
  assert.deepEqual(finalDateien(s.dir), []);
});

test('letzte Bestätigung: status abgeschlossen, pdf_pfad zeigt auf final-*.pdf, letzte Seite enthält "Zur Kenntnis genommen" und beide Namen', async (t) => {
  const s = await setup(t);
  await bestaetige(s, '2');
  const res = await bestaetige(s, '3');
  assert.equal(res.status, 302);
  const job = getJobById(s.db, s.jobId);
  assert.equal(job.status, 'abgeschlossen');
  assert.ok(job.abgeschlossen_am);
  assert.match(basename(job.pdf_pfad), /^final-.*\.pdf$/);
  assert.match(job.final_datei_hash, /^[0-9a-f]{64}$/);
  assert.equal(job.zeitstempel_erforderlich, 0);
  const text = letzteSeite(job.pdf_pfad);
  assert.match(text, /Zur Kenntnis genommen/);
  assert.match(text, /Anna Empfang/);
  assert.match(text, /Bruno Empfang/);
  assert.match(text, /Buch Haltung/);
  assert.equal(listFreigabenByJob(s.db, s.jobId).filter((f) => f.rolle === 'rapport_bestaetigt').length, 2);
});

test('mit TSA (mockTsa): zeitstempel_gesetzt_am gesetzt; TSA down: zeitstempel_erforderlich = 1, gesetzt_am NULL', async (t) => {
  const mitTsa = await setup(t, { empfaenger: ['2'] });
  setConfigValue(mitTsa.db, 'zeitstempel_tsa_url', 'https://tsa.example.org/tsr');
  const client = setupMockTsa('https://tsa.example.org/tsr');
  client.intercept({ path: '/tsr', method: 'POST' }).reply(200, signedTsaResponse, { headers: { 'content-type': 'application/timestamp-reply' } });
  assert.equal((await bestaetige(mitTsa, '2')).status, 302);
  const job = getJobById(mitTsa.db, mitTsa.jobId);
  assert.equal(job.status, 'abgeschlossen');
  assert.ok(job.zeitstempel_gesetzt_am);
  assert.equal(job.zeitstempel_erforderlich, 1);
  assert.ok(mitTsa.db.prepare("SELECT 1 FROM tsa_pruefnachweise WHERE job_id = ?").get(mitTsa.jobId), 'TSA-Nachweis gespeichert');

  const ohneTsa = await setup(t, { empfaenger: ['2'] });
  setConfigValue(ohneTsa.db, 'zeitstempel_tsa_url', 'https://tsa.example.org/tsr');
  const down = setupMockTsa('https://tsa.example.org/tsr');
  down.intercept({ path: '/tsr', method: 'POST' }).reply(503, 'down');
  assert.equal((await bestaetige(ohneTsa, '2')).status, 302);
  const job2 = getJobById(ohneTsa.db, ohneTsa.jobId);
  assert.equal(job2.status, 'abgeschlossen');
  assert.equal(job2.zeitstempel_gesetzt_am, null);
  assert.equal(job2.zeitstempel_erforderlich, 1);
});

test('doppeltes POST derselben Person → zweite Antwort Redirect, nur eine rapport_bestaetigt-Zeile', async (t) => {
  const s = await setup(t);
  assert.equal((await bestaetige(s, '2')).status, 302);
  const zweite = await bestaetige(s, '2');
  assert.equal(zweite.status, 302);
  assert.equal(listFreigabenByJob(s.db, s.jobId).filter((f) => f.rolle === 'rapport_bestaetigt').length, 1);
  // auch nach dem Abschluss: erneutes POST bleibt folgenlos
  await bestaetige(s, '3');
  assert.equal((await bestaetige(s, '3')).status, 302);
  assert.equal(listFreigabenByJob(s.db, s.jobId).filter((f) => f.rolle === 'rapport_bestaetigt').length, 2);
  assert.equal(finalDateien(s.dir).length, 1);
});

test('zwei letzte Bestätigungen parallel (Promise.all) → genau ein Abschluss, keine verwaiste final-*.pdf', async (t) => {
  const s = await setup(t);
  const [a, b] = await Promise.all([bestaetige(s, '2'), bestaetige(s, '3')]);
  assert.equal(a.status, 302);
  assert.equal(b.status, 302);
  const job = getJobById(s.db, s.jobId);
  assert.equal(job.status, 'abgeschlossen');
  assert.deepEqual(finalDateien(s.dir), [basename(job.pdf_pfad)]);

  // Direkt: zwei gleichzeitige Abschlüsse desselben vollständigen Rapports (Verlierer räumt auf).
  const r = await setup(t, { empfaenger: ['2', '3'] });
  await bestaetige(r, '2');
  // letzter offener Empfänger wird entfernt (≥1 bestätigt, 0 offen) → Abschluss über finalisiereRapport
  const offen = listKenntnisnahmen(r.db, r.jobId).find((k) => !k.bestaetigt_am);
  assert.equal(entferneEmpfaenger(r.db, offen.id, { von: '9', begruendung: 'ist ausgetreten', zeitpunkt: new Date().toISOString() }), 'entfernt');
  const ergebnisse = await Promise.all([finalisiereRapport(r.db, r.config, r.jobId), finalisiereRapport(r.db, r.config, r.jobId)]);
  assert.deepEqual(ergebnisse.sort(), [false, true]);
  const job2 = getJobById(r.db, r.jobId);
  assert.equal(job2.status, 'abgeschlossen');
  assert.deepEqual(finalDateien(r.dir), [basename(job2.pdf_pfad)]);
  const text = letzteSeite(job2.pdf_pfad);
  assert.match(text, /ist ausgetreten/);
  assert.equal(await finalisiereRapport(r.db, r.config, r.jobId), false, 'abgeschlossener Rapport wird nicht erneut finalisiert');
});

test('abgeschlossener Rapport erscheint in /meine-abgeschlossenen für Markierer und Empfänger', async (t) => {
  const s = await setup(t, { empfaenger: ['2'] });
  await bestaetige(s, '2');
  for (const person of ['1', '2']) {
    const res = await request(s.app).get('/meine-abgeschlossenen').set('x-test-person-id', person);
    assert.match(res.text, new RegExp(`abgeschlossen-row-${s.jobId}`), person);
  }
  const fremd = await request(s.app).get('/meine-abgeschlossenen').set('x-test-person-id', '6');
  assert.doesNotMatch(fremd.text, new RegExp(`abgeschlossen-row-${s.jobId}`));
});

test('Kommentar auf offenem Rapport möglich, nach Abschluss nur lesbar', async (t) => {
  const s = await setup(t, { empfaenger: ['2'] });
  const kommentar = (text) => request(s.app).post(`/kommentare/${s.jobId}`).set('x-test-person-id', '2').type('form').send({ text, zurueck: `/rapporte/${s.jobId}` });
  const res = await kommentar('Betrifft mich nicht');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, `/rapporte/${s.jobId}#kommentare`);
  const offen = await request(s.app).get(`/rapporte/${s.jobId}`).set('x-test-person-id', '2');
  assert.match(offen.text, /Betrifft mich nicht/);
  assert.match(offen.text, new RegExp(`action="/kommentare/${s.jobId}"`));
  const mail = s.db.prepare("SELECT * FROM mail_log WHERE typ = 'kommentar' AND empfaenger = '1@example.org'").get();
  assert.ok(mail, 'die markierende Person wird über den Kommentar informiert');
  assert.match(mail.text, new RegExp(`/rapporte/${s.jobId}#kommentare`));

  await bestaetige(s, '2');
  assert.equal(getJobById(s.db, s.jobId).status, 'abgeschlossen');
  assert.match(letzteSeite(getJobById(s.db, s.jobId).pdf_pfad), /Betrifft mich nicht/, 'Kommentar steht auf dem Vermerk');
  const zu = await request(s.app).get(`/rapporte/${s.jobId}`).set('x-test-person-id', '2');
  assert.match(zu.text, /Betrifft mich nicht/);
  assert.doesNotMatch(zu.text, new RegExp(`action="/kommentare/${s.jobId}"`));
  assert.equal((await kommentar('Nachtrag')).status, 422);
});

test('Markierung aufheben: Knopf für Markierer bis zur ersten Bestätigung; Dritter mit Eingriffsrecht landet auf /pool', async (t) => {
  const s = await setup(t);
  const seite = await request(s.app).get(`/rapporte/${s.jobId}`).set('x-test-person-id', '1');
  assert.match(seite.text, new RegExp(`action="/kontierung/${s.jobId}/rapport-aufheben"`));
  const empf = await request(s.app).get(`/rapporte/${s.jobId}`).set('x-test-person-id', '2');
  assert.doesNotMatch(empf.text, /rapport-aufheben/);
  const admin = await request(s.app).post(`/kontierung/${s.jobId}/rapport-aufheben`).set('x-test-person-id', '9').type('form').send({});
  assert.equal(admin.status, 302);
  assert.equal(admin.headers.location, '/pool');

  const r = await setup(t);
  await bestaetige(r, '2');
  const nach = await request(r.app).get(`/rapporte/${r.jobId}`).set('x-test-person-id', '1');
  assert.doesNotMatch(nach.text, /rapport-aufheben/);
});
