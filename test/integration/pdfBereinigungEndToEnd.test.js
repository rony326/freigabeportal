import { test } from 'node:test';
import { kreditorOhneIbanPflicht } from '../helpers/kreditor.js';
import assert from 'node:assert/strict';
import request from 'supertest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createKonto } from '../../src/db/kontenRepo.js';
import { createKreditor } from '../../src/db/kreditorenRepo.js';
import { seedDefaults } from '../../src/db/adminConfigRepo.js';
import { getJobById } from '../../src/db/jobsRepo.js';
import { createApp } from '../../src/app.js';
import { setupMockChurchTools } from '../helpers/mockChurchTools.js';
import { buildPdfFixture } from '../helpers/pdfFixture.js';
import { fetchCsrfToken } from '../helpers/csrf.js';
import { ARCHIVE_RETENTION_MS } from '../../src/services/archiveReceipt.js';
import { createSpesenabrechnung } from '../../src/db/spesenabrechnungenRepo.js';
import { listMailLog, listMailAnhaenge } from '../../src/db/mailLogRepo.js';
import { sichereBelegKopie, pruefeSpesenBestaetigung } from '../../src/services/spesenBestaetigung.js';
import { spesenPosition } from '../helpers/spesenVersand.js';

function testConfig(jobsDir) {
  return {
    sessionSecret: 'test-secret',
    env: 'test',
    churchtools: {
      baseUrl: 'https://ct.example.org',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri: 'https://portal.example.org/auth/callback',
      groupIdBuchhaltung: '10',
      groupIdAdmin: '20',
      syncServiceToken: 'token',
    },
    cronSecret: 'cron-secret',
    n8nApiKey: 'n8n-key',
    smtp: { host: 'smtp.example.org', port: 587, user: 'user', pass: 'pass', from: 'portal@example.org' },
    brandingDir: jobsDir,
    jobsDir,
    downloadSigningSecret: 'download-secret',
  };
}

async function loginAs(app, client, { id, vorname, nachname, email, gruppen }) {
  client.intercept({ path: '/oauth/access_token', method: 'POST' }).reply(200, { access_token: `tok-${id}` });
  client.intercept({ path: '/oauth/userinfo', method: 'GET' }).reply(200, { id, firstName: vorname, lastName: nachname, email });
  client
    .intercept({ path: '/api/groups/10/members', method: 'GET' })
    .reply(200, { data: gruppen.includes('10') ? [{ personId: id }] : [] });
  client
    .intercept({ path: '/api/groups/20/members', method: 'GET' })
    .reply(200, { data: gruppen.includes('20') ? [{ personId: id }] : [] });

  const agent = request.agent(app);
  const loginRes = await agent.get('/auth/login');
  const state = new URL(loginRes.headers.location).searchParams.get('state');
  const callbackRes = await agent.get('/auth/callback').query({ code: `code-${id}`, state });
  assert.equal(callbackRes.status, 302, `login for person ${id} should succeed`);
  return agent;
}

test('a complete workflow retains files until archive receipt and retention, then cleans up idempotently', async (t) => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  const jobsDir = mkdtempSync(join(tmpdir(), 'pdf-bereinigung-e2e-test-'));
  const config = testConfig(jobsDir);
  const app = createApp({ db, config });
  const client = setupMockChurchTools(config.churchtools.baseUrl);

  upsertPerson(db, { id: '1', vorname: 'Freigeber', nachname: 'Eins', email: 'f1@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '2', vorname: 'Stellvertreter', nachname: 'Eins', email: 's1@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '3', vorname: 'Freigeber', nachname: 'Zwei', email: 'f2@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '4', vorname: 'Stellvertreter', nachname: 'Zwei', email: 's2@example.org', gruppen: ['10'], loggedInNow: false });
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  const kreditorId = kreditorOhneIbanPflicht(db, { name: 'Muster AG', kontoId: null });

  const pdf = await buildPdfFixture(['Rechnung Seite 1', 'Visum / Rechnungsfreigabe']);
  const createRes = await request(app)
    .post('/api/n8n/jobs')
    .set('X-API-Key', 'n8n-key')
    .field('quelle', 'scanner')
    .field('dateiname', 'rechnung.pdf')
    .attach('pdf', pdf, { filename: 'rechnung.pdf', contentType: 'application/pdf' });
  assert.equal(createRes.status, 201);
  const jobId = createRes.body.id;

  const freigeber1Agent = await loginAs(app, client, { id: 1, vorname: 'Freigeber', nachname: 'Eins', email: 'f1@example.org', gruppen: ['10'] });
  const freigeber1Token = await fetchCsrfToken(freigeber1Agent, '/pool');
  await freigeber1Agent.post(`/api/pool/${jobId}/beanspruchen`).type('form').send({ _csrf: freigeber1Token });
  await freigeber1Agent.post(`/kontierung/${jobId}`).type('form').send({ kontoId: String(kontoId), kreditorId: String(kreditorId), absender: 'Muster AG', rechnungsnummer: 'RE-1', betrag: '100.00', zahlungsziel: '2026-09-01', interessenskonflikt: 'nein', begruendung: '', _csrf: freigeber1Token });

  const freigeber2Agent = await loginAs(app, client, { id: 3, vorname: 'Freigeber', nachname: 'Zwei', email: 'f2@example.org', gruppen: ['10'] });
  const freigeber2Token = await fetchCsrfToken(freigeber2Agent, '/pool');
  await freigeber2Agent.post(`/freigabe2/${jobId}`).type('form').send({ interessenskonflikt: 'nein', begruendung: '', _csrf: freigeber2Token });

  const abholbereitRes = await request(app).get('/api/n8n/jobs/abholbereit').set('X-API-Key', 'n8n-key');
  assert.equal(abholbereitRes.body.length, 1);

  const bestaetigenRes = await request(app).post(`/api/n8n/jobs/${jobId}/abholung-bestaetigen`).set('X-API-Key', 'n8n-key');
  assert.equal(bestaetigenRes.status, 200);
  assert.equal(bestaetigenRes.body.status, 'abgeholt');

  const jobAfterAbholung = getJobById(db, jobId);
  assert.equal(existsSync(jobAfterAbholung.pdf_pfad), true, 'transport ACK must retain the PDF');
  const held = await request(app).post('/internal/cron/pdf-bereinigung').set('X-Cron-Secret', 'cron-secret');
  assert.equal(held.body.archiviert, 0);
  const manifestRes = await request(app).get(`/api/n8n/jobs/${jobId}/exportnachweis`).set('X-API-Key', 'n8n-key');
  assert.equal(manifestRes.status, 200);
  const manifest = manifestRes.body;
  const receipt = await request(app).post(`/api/n8n/jobs/${jobId}/archivierung-bestaetigen`).set('X-API-Key', 'n8n-key').send({
    export_id: manifest.export_id, sha256: manifest.sha256, dokument_id: 123,
    task_id: 'b2ba769c-455f-4d97-9fb6-986eac19a334',
  });
  assert.equal(receipt.status, 200);
  t.mock.method(Date, 'now', () => Date.parse(receipt.body.quittung.bestaetigt_am) + ARCHIVE_RETENTION_MS);

  const sweep1 = await request(app).post('/internal/cron/pdf-bereinigung').set('X-Cron-Secret', 'cron-secret');
  assert.equal(sweep1.status, 200);
  assert.equal(sweep1.body.archiviert, 1);
  assert.equal(getJobById(db, jobId).status, 'archiviert');
  assert.ok(getJobById(db, jobId).archiviert_am);
  assert.equal(existsSync(jobAfterAbholung.pdf_pfad), false);

  const sweep2 = await request(app).post('/internal/cron/pdf-bereinigung').set('X-Cron-Secret', 'cron-secret');
  assert.equal(sweep2.status, 200);
  assert.equal(sweep2.body.archiviert, 0, 'the job is already archiviert — nothing left for a second run to do');

  db.close();
  rmSync(jobsDir, { recursive: true, force: true });
});

test('ein quittierter Rapport ist nach 7 Tagen archiviert und seine Datei entfernt', async (t) => {
  const { createJob, claimJob } = await import('../../src/db/jobsRepo.js');
  const { setConfigValue } = await import('../../src/db/adminConfigRepo.js');
  const { markiereRapport, bestaetigeRapport } = await import('../../src/services/rapporte.js');
  const { writeFileSync } = await import('node:fs');
  const db = openDatabase(':memory:');
  seedDefaults(db);
  setConfigValue(db, 'modul_rapporte_aktiv', '1');
  setConfigValue(db, 'zeitstempel_tsa_url', '');
  const jobsDir = mkdtempSync(join(tmpdir(), 'pdf-bereinigung-rapport-test-'));
  t.after(() => { db.close(); rmSync(jobsDir, { recursive: true, force: true }); });
  const config = testConfig(jobsDir);
  const app = createApp({ db, config });
  upsertPerson(db, { id: '1', vorname: 'Buch', nachname: 'Haltung', email: 'b@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '2', vorname: 'Anna', nachname: 'Empfang', email: 'a@example.org', gruppen: [], loggedInNow: false });

  const pdfPfad = join(jobsDir, 'rapport.pdf');
  writeFileSync(pdfPfad, await buildPdfFixture(['Rapport Seite 1']));
  const jobId = createJob(db, { eingangAm: '2026-11-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'rapport.pdf', pdfPfad });
  claimJob(db, jobId, '1');
  const mailer = { async sendMail() {} };
  assert.equal((await markiereRapport(db, config, mailer, { job: getJobById(db, jobId), person: { churchtools_person_id: '1', vorname: 'Buch', nachname: 'Haltung' }, empfaengerIds: ['2'], bemerkung: null, ip: '' })).ok, true);
  assert.equal((await bestaetigeRapport(db, config, { jobId, person: { churchtools_person_id: '2', vorname: 'Anna', nachname: 'Empfang' }, ip: '' })).abgeschlossen, true);
  const finalPfad = getJobById(db, jobId).pdf_pfad;

  const manifest = (await request(app).get(`/api/n8n/rapporte/${jobId}/exportnachweis`).set('X-API-Key', 'n8n-key')).body;
  const receipt = await request(app).post(`/api/n8n/rapporte/${jobId}/archivierung-bestaetigen`).set('X-API-Key', 'n8n-key').send({
    export_id: manifest.export_id, sha256: manifest.sha256, dokument_id: 321, task_id: 'b2ba769c-455f-4d97-9fb6-986eac19a334',
  });
  assert.equal(receipt.status, 200);
  assert.equal(getJobById(db, jobId).status, 'abgeholt');

  const zuFrueh = await request(app).post('/internal/cron/pdf-bereinigung').set('X-Cron-Secret', 'cron-secret');
  assert.equal(zuFrueh.body.archiviert, 0);
  assert.equal(existsSync(finalPfad), true, 'vor Ablauf der Aufbewahrung bleibt die Datei');

  t.mock.method(Date, 'now', () => Date.parse(receipt.body.quittung.bestaetigt_am) + ARCHIVE_RETENTION_MS);
  const sweep = await request(app).post('/internal/cron/pdf-bereinigung').set('X-Cron-Secret', 'cron-secret');
  assert.equal(sweep.status, 200);
  assert.equal(sweep.body.archiviert, 1);
  assert.equal(getJobById(db, jobId).status, 'archiviert');
  assert.equal(existsSync(finalPfad), false);
});

function spesenSetup(t) {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  const jobsDir = mkdtempSync(join(tmpdir(), 'pdf-bereinigung-spesen-test-'));
  t.after(() => { db.close(); rmSync(jobsDir, { recursive: true, force: true }); });
  const config = { ...testConfig(jobsDir), publicBaseUrl: 'https://portal.example.org' };
  const app = createApp({ db, config });
  upsertPerson(db, { id: '1', vorname: 'Anna', nachname: 'Muster', email: 'anna@example.org', gruppen: [], loggedInNow: false });
  const abrechnung = () => createSpesenabrechnung(db, { eingereichtVon: '1', eingereichtAm: '2026-11-01T10:00:00.000Z', titel: 'Lager' });
  const position = (spesenabrechnungId, name, versandt = true) =>
    spesenPosition(db, { spesenabrechnungId, eingereichtVon: '1', pdfPfad: join(jobsDir, `${name}.pdf`), versandt });
  const lauf = async () => {
    const res = await request(app).post('/internal/cron/pdf-bereinigung').set('X-Cron-Secret', 'cron-secret');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body;
  };
  const kopien = () => db.prepare('SELECT job_id, pfad FROM spesen_beleg_kopien ORDER BY job_id').all();
  return { db, config: { jobsDir, publicBaseUrl: 'https://portal.example.org' }, abrechnung, position, lauf, kopien };
}

test('Kopie bleibt bis zur Mail-Aufbewahrung, danach gelöscht mit Audit', async (t) => {
  const s = spesenSetup(t);
  const entschieden = s.abrechnung();
  const a = s.position(entschieden, 'a');
  assert.equal(pruefeSpesenBestaetigung(s.db, s.config, entschieden).ergebnis, 'eingereiht');
  // Zweite, noch offene Abrechnung: ihre Kopie darf nie verschwinden.
  const offen = s.abrechnung();
  const b = s.position(offen, 'b');
  s.position(offen, 'c', false);
  sichereBelegKopie(s.db, s.config, b.id);
  const kopieA = s.kopien().find((k) => k.job_id === a.id).pfad;
  const kopieB = s.kopien().find((k) => k.job_id === b.id).pfad;

  const vorher = await s.lauf();
  assert.equal(vorher.belegKopienGeloescht, 0);
  assert.equal(existsSync(kopieA), true, 'solange die Mail im Protokoll steht, bleibt die Kopie');

  s.db.prepare("UPDATE mail_log SET status = 'versendet', versucht_am = '2020-01-01T00:00:00.000Z'").run();
  const danach = await s.lauf();
  assert.equal(danach.mailLogGeloescht, 1);
  assert.equal(danach.belegKopienGeloescht, 1);
  assert.equal(existsSync(kopieA), false);
  assert.equal(existsSync(kopieB), true);
  assert.deepEqual(s.kopien().map((k) => k.job_id), [b.id]);
  const ereignisse = s.db.prepare("SELECT * FROM audit_ereignisse WHERE aktion = 'datei_geloescht' AND objekt = 'jobs' AND objekt_id = ?").all(String(a.id));
  assert.equal(ereignisse.length, 1);
  assert.match(ereignisse[0].nachher, /"dateiart":"mail_anhang"/);
  assert.equal(ereignisse[0].begruendung, 'Spesen-Bestätigung erledigt');
  assert.match(s.db.prepare("SELECT details FROM cron_log WHERE job = 'pdf-bereinigung' ORDER BY id DESC").get().details, /Beleg-Kopien gelöscht: 1/);
});

test('Nachholen im Nachtlauf reiht übersehene Bestätigung ein', async (t) => {
  const s = spesenSetup(t);
  const id = s.abrechnung();
  s.position(id, 'a');
  const ergebnis = await s.lauf();
  assert.equal(ergebnis.spesenBestaetigungenNachgeholt, 1);
  assert.equal(ergebnis.belegKopienGeloescht, 0);
  const [mail] = listMailLog(s.db);
  assert.equal(mail.typ, 'spesen-bestaetigung');
  assert.equal(mail.status, 'eingereiht', 'die Zustellung übernimmt der Job mail-zustellung');
  assert.equal(listMailAnhaenge(s.db, mail.id).length, 1);
  assert.equal((await s.lauf()).spesenBestaetigungenNachgeholt, 0);
  assert.equal(listMailLog(s.db).length, 1);
});
