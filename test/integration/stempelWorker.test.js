// B2, Etappe 3: Die Stempel (Freigabe 2: stampAndFinalize, Rapport: stampKenntnisnahme) rechnen im PDF-Worker.
// Geprüft wird: Störung des Workers bei Freigabe 2 → 503, der Vorgang bleibt unverändert (Status, Freigaben, PDF-Bytes,
// keine Datei übrig); ein echter Stempelfehler bleibt 400 mit derselben Meldung. Rapport: Störung beim Abschluss → keine 500,
// die Kenntnisnahme bleibt gespeichert, der Rapport bleibt 'kenntnisnahme' ohne Teilzustand, der Nachhol-Mechanismus schliesst ab.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { buildPdfFixture } from '../helpers/pdfFixture.js';
import { mitPdfStoerung } from '../helpers/pdfStoerung.js';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createKonto } from '../../src/db/kontenRepo.js';
import { createJob, setKontierung, getJobById, claimJob } from '../../src/db/jobsRepo.js';
import { createFreigabe, listFreigabenByJob } from '../../src/db/freigabenRepo.js';
import { listKenntnisnahmen } from '../../src/db/rapporteRepo.js';
import { seedDefaults, setConfigValue } from '../../src/db/adminConfigRepo.js';
import { loadCurrentPerson, requireLogin } from '../../src/middleware/roles.js';
import { loadNavFlags } from '../../src/middleware/nav.js';
import { createFreigabe2Router } from '../../src/routes/freigabe2.js';
import { createRapporteRouter } from '../../src/routes/rapporte.js';
import { markiereRapport, schliesseRapporteNach } from '../../src/services/rapporte.js';

const mitMarke = async (seiten, marke) => Buffer.concat([await buildPdfFixture(seiten), Buffer.from(`\n%${marke}\n`)]);

function basisApp(db, config) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', new URL('../../views', import.meta.url).pathname);
  app.use((req, res, next) => { res.locals.branding = { primaryColor: '#000', secondaryColor: '#fff', hasLogo: false, themeAttr: null }; next(); });
  app.use(express.urlencoded({ extended: false }));
  app.use((req, res, next) => { req.session = { personId: req.headers['x-test-person-id'] }; next(); });
  app.use(loadCurrentPerson(db));
  app.use(loadNavFlags(db, config));
  return app;
}

// ---------- Freigabe 2 ----------

async function setupFreigabe2(t, pdfBytes) {
  const dir = mkdtempSync(join(tmpdir(), 'freigabe2-stempel-worker-'));
  const db = openDatabase(':memory:');
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  seedDefaults(db);
  for (const id of ['1', '2', '3', '4']) {
    upsertPerson(db, { id, vorname: `Person${id}`, nachname: 'Muster', email: `p${id}@example.org`, gruppen: ['10'], loggedInNow: true });
  }
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  const pdfPfad = join(dir, 'a.pdf');
  writeFileSync(pdfPfad, pdfBytes);
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad });
  setKontierung(db, jobId, kontoId);
  createFreigabe(db, { jobId, personId: '1', rolle: 'freigeber1', zeitpunkt: '2026-08-15T08:30:00.000Z', ip: '1.2.3.4', interessenskonflikt: false, kommentar: null, eskaliertVon: null });
  db.prepare("UPDATE jobs SET status = 'freigabe2', zugewiesen_an = '1' WHERE id = ?").run(jobId);
  const config = { tsaTrustRequired: false, churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20' }, downloadSigningSecret: 's', publicBaseUrl: 'https://portal.example.org' };
  const app = basisApp(db, config);
  app.use('/freigabe2', requireLogin(), createFreigabe2Router({ db, config, mailer: { async sendMail() {} } }));
  return { db, app, dir, jobId, pdfPfad };
}

function freigeben(s) {
  return request(s.app).post(`/freigabe2/${s.jobId}`).set('x-test-person-id', '3').type('form').send({ interessenskonflikt: 'nein', begruendung: 'Passt so' });
}

// Alles, was ein abgewiesener Versuch nicht ändern darf.
function freigabe2Stand(s) {
  const job = getJobById(s.db, s.jobId);
  return {
    status: job.status, pdf_pfad: job.pdf_pfad, final_datei_hash: job.final_datei_hash, freigabe_snapshot: job.freigabe_snapshot,
    zeitstempel_erforderlich: job.zeitstempel_erforderlich,
    freigaben: listFreigabenByJob(s.db, s.jobId).map((f) => f.rolle),
    pdf: readFileSync(s.pdfPfad).toString('base64'),
    dateien: readdirSync(s.dir).sort(),
  };
}

function pruefe503(res) {
  assert.equal(res.status, 503);
  assert.equal(res.headers['retry-after'], '60');
  assert.match(res.text, /in einer Minute erneut/);
  assert.match(res.text, /Es wurde nichts gespeichert/);
  assert.match(res.text, /Passt so/, 'die Begründung bleibt im Formular');
  // Bei Freigabe 2 gibt es keine Datei hochzuladen – der Hinweis darf nicht dazu auffordern.
  assert.doesNotMatch(res.text, /Datei\(en\) noch einmal/);
}

test('B2 Etappe 3: Freigabe 2 – überlasteter Worker → 503 mit Formular, Vorgang, Freigaben und PDF unverändert, keine Datei übrig', async (t) => {
  const s = await setupFreigabe2(t, await buildPdfFixture(['Rechnung Seite 1']));
  const vorher = freigabe2Stand(s);
  const res = await mitPdfStoerung('ueberlastet', () => freigeben(s));
  pruefe503(res);
  assert.deepEqual(freigabe2Stand(s), vorher);

  // Nach der Störung klappt derselbe Versuch.
  const zweiter = await freigeben(s);
  assert.equal(zweiter.status, 302);
  const job = getJobById(s.db, s.jobId);
  assert.equal(job.status, 'abgeschlossen');
  assert.equal((await PDFDocument.load(readFileSync(job.pdf_pfad))).getPageCount(), 2, 'Rechnung + Stempelseite');
});

test('B2 Etappe 3: Freigabe 2 – Zeitlimit des Workers beim Stempeln → 503, nichts gespeichert', async (t) => {
  const s = await setupFreigabe2(t, await mitMarke(['Rechnung Seite 1'], 'LANGSAM_STEMPELN'));
  const vorher = freigabe2Stand(s);
  const res = await mitPdfStoerung('zeitlimit', () => freigeben(s));
  pruefe503(res);
  assert.deepEqual(freigabe2Stand(s), vorher);
});

test('B2 Etappe 3: Freigabe 2 – echter Stempelfehler (unlesbares PDF) bleibt 400 mit der Meldung des Stempels, ohne Retry-After', async (t) => {
  const s = await setupFreigabe2(t, Buffer.from('%PDF-1.4\nkein echtes PDF\n'));
  const vorher = freigabe2Stand(s);
  const res = await freigeben(s);
  assert.equal(res.status, 400);
  assert.equal(res.headers['retry-after'], undefined);
  assert.match(res.text, /PDF konnte nicht (geladen|gestempelt) werden/);
  assert.deepEqual(freigabe2Stand(s), vorher);
});

// ---------- Rapport ----------

async function setupRapport(t, pdfBytes) {
  const dir = mkdtempSync(join(tmpdir(), 'rapport-stempel-worker-'));
  const db = openDatabase(':memory:');
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  seedDefaults(db);
  setConfigValue(db, 'modul_rapporte_aktiv', '1');
  for (const [id, vorname, gruppen] of [['1', 'Buch', ['10']], ['2', 'Anna', []]]) {
    upsertPerson(db, { id, vorname, nachname: 'Muster', email: `${id}@example.org`, gruppen });
  }
  const config = { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20', groupIdManager: '30' }, downloadSigningSecret: 's', publicBaseUrl: 'https://portal.example.org', tsaTrustRequired: false, jobsDir: dir };
  const pdfPfad = join(dir, 'rapport.pdf');
  writeFileSync(pdfPfad, pdfBytes);
  const jobId = createJob(db, { eingangAm: '2026-11-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'rapport.pdf', pdfPfad });
  claimJob(db, jobId, '1');
  const mailer = { async sendMail() {} };
  const markiert = await markiereRapport(db, config, mailer, { job: getJobById(db, jobId), person: { churchtools_person_id: '1', vorname: 'Buch', nachname: 'Muster' }, empfaengerIds: ['2'], bemerkung: 'Bitte lesen', ip: '' });
  assert.equal(markiert.ok, true);
  const app = basisApp(db, config);
  app.use('/rapporte', requireLogin(), createRapporteRouter({ db, config, mailer }));
  return { db, app, dir, jobId, pdfPfad, config };
}

function rapportStand(s) {
  const job = getJobById(s.db, s.jobId);
  return {
    status: job.status, pdf_pfad: job.pdf_pfad, final_datei_hash: job.final_datei_hash, abgeschlossen_am: job.abgeschlossen_am,
    pdf: readFileSync(s.pdfPfad).toString('base64'),
    dateien: readdirSync(s.dir).sort(),
  };
}

async function pruefeNachgeholt(s) {
  const nach = await schliesseRapporteNach(s.db, s.config);
  assert.deepEqual(nach, { nachgeholt: 1, fehlgeschlagen: [] });
  const job = getJobById(s.db, s.jobId);
  assert.equal(job.status, 'abgeschlossen');
  assert.match(job.pdf_pfad, /final-.*\.pdf$/);
  assert.equal((await PDFDocument.load(readFileSync(job.pdf_pfad))).getPageCount(), 2, 'Rapport + Vermerkseite');
}

for (const art of ['ueberlastet', 'zeitlimit']) {
  test(`B2 Etappe 3: Rapport – Störung (${art}) beim Abschluss nach der letzten Kenntnisnahme → Redirect statt 500, Kenntnisnahme bleibt, Rapport offen ohne Teilzustand; Nachholen schliesst ab`, async (t) => {
    const s = await setupRapport(t, art === 'zeitlimit' ? await mitMarke(['Rapport Seite 1'], 'LANGSAM_STEMPELN') : await buildPdfFixture(['Rapport Seite 1']));
    const vorher = rapportStand(s);
    const res = await mitPdfStoerung(art, () => request(s.app).post(`/rapporte/${s.jobId}/bestaetigen`).set('x-test-person-id', '2').type('form').send({}));
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, `/rapporte/${s.jobId}`);
    // Wie bei jedem anderen Stempelfehler: die Kenntnisnahme ist gespeichert, der Abschluss nicht.
    assert.ok(listKenntnisnahmen(s.db, s.jobId).find((k) => k.person_id === '2').bestaetigt_am);
    assert.ok(listFreigabenByJob(s.db, s.jobId).some((f) => f.rolle === 'rapport_bestaetigt'));
    assert.deepEqual(rapportStand(s), vorher);
    await pruefeNachgeholt(s);
  });
}

test('B2 Etappe 3: Rapport-Nachholen (Cron) bei gestörtem Worker → als fehlgeschlagen gemeldet, nichts geschrieben; der nächste Lauf schliesst ab', async (t) => {
  const s = await setupRapport(t, await buildPdfFixture(['Rapport Seite 1']));
  await mitPdfStoerung('ueberlastet', () => request(s.app).post(`/rapporte/${s.jobId}/bestaetigen`).set('x-test-person-id', '2').type('form').send({}));
  const vorher = rapportStand(s);
  const lauf = await mitPdfStoerung('ueberlastet', () => schliesseRapporteNach(s.db, s.config));
  assert.deepEqual(lauf, { nachgeholt: 0, fehlgeschlagen: [s.jobId] });
  assert.deepEqual(rapportStand(s), vorher);
  await pruefeNachgeholt(s);
});
