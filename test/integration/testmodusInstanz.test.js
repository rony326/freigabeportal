import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import express from 'express';
import nodemailer from 'nodemailer';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockAgent, setGlobalDispatcher } from 'undici';
import { openDatabase } from '../../src/db/index.js';
import { seedDefaults, getConfigValue, setConfigValue } from '../../src/db/adminConfigRepo.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createJob } from '../../src/db/jobsRepo.js';
import { createApp } from '../../src/app.js';
import { buildSignedDownloadUrl } from '../../src/services/downloadUrl.js';
import { erstelleSpielwiese } from '../../src/services/testmodus/spielwiese.js';
import { createTestMailer } from '../../src/services/testmodus/testMailer.js';
import { buildPdfFixture } from '../helpers/pdfFixture.js';

// Jeder ausgehende fetch/undici-Aufruf wird festgehalten und scheitert (kein Netz).
const netzVersuche = [];
const mockAgent = new MockAgent();
mockAgent.disableNetConnect();
const dispatchOriginal = mockAgent.dispatch.bind(mockAgent);
mockAgent.dispatch = (opts, handler) => {
  netzVersuche.push(`${opts.method} ${opts.origin}${opts.path}`);
  return dispatchOriginal(opts, handler);
};
setGlobalDispatcher(mockAgent);

const N8N = 'n'.repeat(32);
const CRON = 'c'.repeat(32);
const BACKUP = 'b'.repeat(32);

async function umgebung({ mailer: mailerOption = 'test', smtpEcht = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'testmodus-instanz-'));
  const config = {
    env: 'test',
    sessionSecret: 'test-secret',
    dbPath: join(dir, 'echt.sqlite'), jobsDir: join(dir, 'jobs'), brandingDir: join(dir, 'branding'),
    backupDir: join(dir, 'backups'), backupKeyringFile: join(dir, 'keyring.json'),
    downloadSigningSecret: 'download-secret',
    n8nApiKey: N8N, cronSecret: CRON, backupApiKey: BACKUP,
    smtp: { host: 'smtp.example.org', port: 587, user: 'u', pass: 'p', from: 'portal@example.org' },
    churchtools: { baseUrl: 'https://echt.example', clientId: 'id', clientSecret: 's'.repeat(32), redirectUri: 'https://echt.example/cb', syncServiceToken: 't'.repeat(32), groupIdAdmin: '1', groupIdBuchhaltung: '2', customFieldIban: 'iban', customFieldKontoinhaber: 'kontoinhaber' },
  };
  // Echte Dateien, die der Testmodus nie anfassen darf.
  for (const d of [config.jobsDir, config.brandingDir, config.backupDir]) mkdirSync(d, { recursive: true });
  writeFileSync(join(config.backupDir, 'sicherung-echt-2026.bin'), 'echtes backup');
  writeFileSync(join(config.brandingDir, 'logo.png'), 'echtes logo');
  const echtPdf = join(config.jobsDir, 'echt-1.pdf');
  writeFileSync(echtPdf, await buildPdfFixture(['Echte Rechnung']));

  const echteDb = openDatabase(config.dbPath);
  seedDefaults(echteDb);
  upsertPerson(echteDb, { id: 'echt-admin', vorname: 'Echt', nachname: 'Admin', email: 'echt@example.org', gruppen: ['1', '2'] });
  const echterJob = createJob(echteDb, { eingangAm: new Date().toISOString(), quelle: 'scanner', absender: null, dateiname: 'echt.pdf', pdfPfad: echtPdf, dateiHash: 'x' });

  const sp = await erstelleSpielwiese(echteDb, config);
  const mailer = mailerOption === 'test' ? createTestMailer() : null;
  const testConfig = smtpEcht ? { ...sp.config, smtp: config.smtp } : sp.config;
  const testApp = createApp({ db: sp.db, config: testConfig, ...(mailer ? { mailer } : {}), testmodus: true });
  const echteApp = createApp({ db: echteDb, config, mailer: createTestMailer() });
  // Mini-Weiche: ein festes Sitzungsobjekt; mit Testmodus an die Test-Instanz, sonst echte App.
  const sitzung = { id: 'sitzung-test', personId: 'echt-admin', testmodus: { personId: 'test-1' } };
  const weiche = { echterToken: null };
  const aussen = express();
  aussen.use((req, res, next) => {
    req.session = sitzung;
    if (!sitzung.testmodus) return echteApp(req, res, next);
    if (weiche.echterToken) req.testmodusEchterCsrfToken = weiche.echterToken;
    return testApp(req, res, next);
  });
  const agent = request.agent(aussen);
  const aufraeumen = () => { sp.db.close(); echteDb.close(); rmSync(dir, { recursive: true, force: true }); };
  return { config, echteDb, db: sp.db, testConfig: sp.config, mailer, sitzung, weiche, agent, aussen, testApp, echteApp, echterJob, aufraeumen };
}

const zaehle = (db) => ['personen', 'jobs', 'mail_log', 'freigaben', 'audit_ereignisse', 'admin_config'].map((t) => db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c);
const dateien = (config) => [config.jobsDir, config.brandingDir, config.backupDir]
  .flatMap((d) => readdirSync(d).map((f) => { const st = statSync(join(d, f)); return `${d}/${f}:${st.size}:${st.mtimeMs}`; })).sort();
const csrfAus = (text) => text.match(/name="_csrf" value="([^"]+)"/)[1];

// Anna kontiert den Pool-Beleg, Anna darf nicht freigeben, Ben gibt frei.
async function rundreise(u) {
  const job = u.db.prepare("SELECT id FROM jobs WHERE dateiname = 'Rechnung im Pool.pdf'").get();
  const konto = u.db.prepare("SELECT id FROM konten WHERE kontonummer = '3000'").get();
  const kreditor = u.db.prepare("SELECT id FROM kreditoren WHERE name = 'Muster Druck AG'").get();
  u.sitzung.testmodus = { personId: 'test-1' };
  const token = csrfAus((await u.agent.get('/pool')).text);
  assert.equal((await u.agent.post(`/api/pool/${job.id}/beanspruchen`).type('form').send({ _csrf: token })).status, 200);
  const kont = await u.agent.post(`/kontierung/${job.id}`).type('form').send({
    kontoId: String(konto.id), kreditorId: String(kreditor.id), absender: 'Muster Druck AG', rechnungsnummer: 'BSP-RT',
    betrag: '120.00', zahlungsziel: '2026-12-31', interessenskonflikt: 'nein', begruendung: '', _csrf: token,
  });
  assert.equal(kont.status, 302);
  assert.equal(u.db.prepare('SELECT status FROM jobs WHERE id = ?').get(job.id).status, 'freigabe2');

  // Vier-Augen: Anna (Freigabe 1) kann nicht auch Freigabe 2 erteilen.
  await u.agent.post(`/freigabe2/${job.id}`).type('form').send({ interessenskonflikt: 'nein', begruendung: '', _csrf: token });
  assert.equal(u.db.prepare('SELECT status FROM jobs WHERE id = ?').get(job.id).status, 'freigabe2');

  u.sitzung.testmodus.personId = 'test-2';
  const formular = await u.agent.get(`/freigabe2/${job.id}`);
  assert.equal(formular.status, 200);
  assert.match(formular.text, /Angemeldet als Ben Beispiel/);
  const f2 = await u.agent.post(`/freigabe2/${job.id}`).type('form').send({ interessenskonflikt: 'nein', begruendung: '', _csrf: csrfAus(formular.text) });
  assert.equal(f2.status, 302);
  assert.equal(u.db.prepare('SELECT status FROM jobs WHERE id = ?').get(job.id).status, 'abgeschlossen');
  const log = u.db.prepare("SELECT status FROM mail_log WHERE empfaenger = 'ben@beispiel.invalid'").all();
  assert.ok(log.length > 0 && log.every((z) => z.status === 'versendet'));
  return job.id;
}

test('Netz-Sperre greift: fetch wird festgehalten und scheitert', async () => {
  netzVersuche.length = 0;
  await assert.rejects(fetch('https://beispiel.invalid/probe'));
  assert.equal(netzVersuche.length, 1);
  netzVersuche.length = 0;
});

test('createTestMailer sammelt nur und schickt nichts', async () => {
  const mailer = createTestMailer();
  await mailer.sendMail({ to: 'a@beispiel.invalid', subject: 'S', text: 'T' });
  assert.deepEqual(mailer.gesendet.map((m) => m.to), ['a@beispiel.invalid']);
});

test('Test-Konfiguration: eigene Geheimnisse und Pfade, nichts Echtes übernommen', async () => {
  const u = await umgebung();
  const t = u.testConfig;
  assert.equal(t.testmodus, true);
  assert.notEqual(t.sessionSecret, u.config.sessionSecret);
  assert.notEqual(t.downloadSigningSecret, u.config.downloadSigningSecret);
  assert.notEqual(t.backupDir, u.config.backupDir);
  assert.equal(t.backupKeyringFile, null);
  assert.equal(t.churchtools.clientSecret, null);
  assert.equal(t.churchtools.syncServiceToken, null);
  assert.equal(t.churchtools.testmodus, true);
  u.aufraeumen();
});

test('/pool zeigt Beispielrechnungen und das Band als Anna', async () => {
  const u = await umgebung();
  const res = await u.agent.get('/pool');
  assert.equal(res.status, 200);
  assert.match(res.text, /Testmodus — nichts hier ist echt/);
  const poolJob = u.db.prepare("SELECT id FROM jobs WHERE dateiname = 'Rechnung im Pool.pdf'").get().id;
  const annasJob = u.db.prepare("SELECT id FROM jobs WHERE dateiname = 'Rechnung bei Anna.pdf'").get().id;
  assert.match(res.text, new RegExp(`id="pool-row-${poolJob}"`));
  assert.match(res.text, new RegExp(`id="kontierung-row-${annasJob}"`));
  assert.match(res.text, /Angemeldet als Anna Beispiel/);
  assert.match(res.text, /action="\/admin\/testmodus\/person"/);
  assert.match(res.text, /<option value="test-2"[^>]*>Ben Beispiel/);
  assert.match(res.text, /<option value="test-1" selected/);
  assert.match(res.text, /action="\/admin\/testmodus\/aus"[\s\S]*?Testmodus beenden/);
  u.aufraeumen();
});

test('Band-Formulare tragen das Token der echten App, nie das der Test-Instanz', async () => {
  const u = await umgebung();
  // Das Jobs-Formular im Band gehört zur Test-Instanz (eigenes Token) und wird hier ausgeklammert.
  const band = (text) => text.slice(text.indexOf('class="testmodus-band"'), text.indexOf('<header')).replace(/<form[^>]*action="\/testmodus\/jobs"[\s\S]*?<\/form>/, '');
  // Ohne Token von der Weiche: leer (Task 3 setzt req.testmodusEchterCsrfToken).
  let res = await u.agent.get('/pool');
  assert.deepEqual(band(res.text).match(/name="_csrf" value="[^"]*"/g), ['name="_csrf" value=""', 'name="_csrf" value=""']);
  u.weiche.echterToken = 'echtes-token-123';
  res = await u.agent.get('/pool');
  assert.deepEqual(band(res.text).match(/name="_csrf" value="[^"]*"/g), ['name="_csrf" value="echtes-token-123"', 'name="_csrf" value="echtes-token-123"']);
  // Die Seitenformulare behalten das Token der Test-Instanz.
  assert.ok(res.text.slice(res.text.indexOf('<header')).match(/name="_csrf" value="(?!echtes-token-123)[^"]+"/));
  u.aufraeumen();
});

test('Band erscheint auch auf Fehlerseiten der Test-Instanz', async () => {
  const u = await umgebung();
  const res = await u.agent.get('/gibt-es-nicht');
  assert.equal(res.status, 404);
  assert.match(res.text, /Testmodus — nichts hier ist echt/);
  u.aufraeumen();
});

test('Rundreise: Mail nur im Test-Mailer, kein Netz, echte DB und echte Dateien unverändert', async () => {
  const u = await umgebung();
  const vorher = zaehle(u.echteDb);
  const dateienVorher = dateien(u.config);
  netzVersuche.length = 0;
  await rundreise(u);
  assert.ok(u.mailer.gesendet.some((m) => m.to === 'ben@beispiel.invalid'));
  assert.ok(u.mailer.gesendet.every((m) => m.to.endsWith('@beispiel.invalid')));
  assert.deepEqual(netzVersuche, []);
  assert.deepEqual(zaehle(u.echteDb), vorher);
  assert.deepEqual(dateien(u.config), dateienVorher);
  u.aufraeumen();
});

test('ohne eingesetzten Mailer: Test-Mailer statt SMTP, nodemailer wird nie benutzt', async () => {
  const original = nodemailer.createTransport;
  let aufrufe = 0;
  nodemailer.createTransport = () => { aufrufe += 1; throw new Error('SMTP darf im Testmodus nicht benutzt werden'); };
  try {
    const u = await umgebung({ mailer: null, smtpEcht: true });
    netzVersuche.length = 0;
    await rundreise(u);
    assert.equal(aufrufe, 0);
    assert.deepEqual(netzVersuche, []);
    u.aufraeumen();
  } finally {
    nodemailer.createTransport = original;
  }
});

test('Backups: Dora erreicht das echte Backup-Verzeichnis nicht', async () => {
  const u = await umgebung();
  u.sitzung.testmodus.personId = 'test-4';
  const vorher = dateien(u.config);
  const liste = await u.agent.get('/admin/backup');
  assert.equal(liste.status, 403);
  assert.match(liste.text, /im Testmodus nicht verfügbar/);
  assert.doesNotMatch(liste.text, /sicherung-echt-2026/);
  const token = csrfAus((await u.agent.get('/pool')).text);
  assert.equal((await u.agent.get('/admin/backup/dateien/sicherung-echt-2026.bin')).status, 403);
  assert.equal((await u.agent.post('/admin/backup/dateien/sicherung-echt-2026.bin/loeschen').type('form').send({ _csrf: token })).status, 403);
  assert.equal((await u.agent.post('/admin/backup').type('form').send({ _csrf: token, aufbewahrungAnzahl: '1' })).status, 403);
  assert.equal((await u.agent.post('/admin/backup/jetzt-ausfuehren').type('form').send({ _csrf: token })).status, 403);
  assert.deepEqual(dateien(u.config), vorher);
  u.aufraeumen();
});

test('Download-Link der Test-Instanz gilt in der echten App nicht', async () => {
  const u = await umgebung();
  const id = u.echterJob;
  assert.ok(u.db.prepare('SELECT id FROM jobs WHERE id = ?').get(id), 'gleiche Job-ID in beiden DBs');
  const testUrl = buildSignedDownloadUrl(u.testConfig, id, 300);
  assert.equal((await u.agent.get(testUrl)).status, 200);
  assert.equal((await request(u.echteApp).get(testUrl)).status, 403);
  assert.equal((await request(u.echteApp).get(buildSignedDownloadUrl(u.config, id, 300))).status, 200);
  u.aufraeumen();
});

test('CSRF-Token der Test-Instanz wird von der echten App abgelehnt (altes Formular nach dem Ausschalten)', async () => {
  const u = await umgebung();
  u.sitzung.testmodus = { personId: 'test-4' };
  const testSeite = await u.agent.get('/admin/module');
  assert.equal(testSeite.status, 200);
  const testToken = csrfAus(testSeite.text);
  u.sitzung.testmodus = null;
  const vorher = getConfigValue(u.echteDb, 'modul_spesen_aktiv');
  const abgelehnt = await u.agent.post('/admin/module').type('form').send({ _csrf: testToken });
  assert.equal(abgelehnt.status, 403);
  assert.equal(getConfigValue(u.echteDb, 'modul_spesen_aktiv'), vorher);
  // Gegenprobe: das echte Token derselben Sitzung wirkt.
  const echtToken = csrfAus((await u.agent.get('/admin/module')).text);
  assert.notEqual(echtToken, testToken);
  assert.equal((await u.agent.post('/admin/module').type('form').send({ _csrf: echtToken })).status, 302);
  u.aufraeumen();
});

test('TSA bleibt aus: Formular gesperrt, DB-Wert bleibt leer, kein Zeitstempel-Aufruf', async () => {
  const u = await umgebung();
  u.sitzung.testmodus = { personId: 'test-4' };
  const seite = await u.agent.get('/admin/zeitstempel');
  assert.equal(seite.status, 200);
  assert.match(seite.text, /<fieldset disabled>/);
  const speichern = await u.agent.post('/admin/zeitstempel').type('form').send({ _csrf: csrfAus(seite.text), tsaUrl: 'https://tsa.example/tsr', warnungAbStunden: '24' });
  assert.equal(speichern.status, 403);
  // Auch jeder andere Schreibweg wird in der Spiel-DB geleert.
  setConfigValue(u.db, 'zeitstempel_tsa_url', 'https://tsa.example/tsr');
  setConfigValue(u.db, 'zeitstempel_tsa_passwort', 'geheim');
  assert.equal(getConfigValue(u.db, 'zeitstempel_tsa_url'), '');
  assert.equal(getConfigValue(u.db, 'zeitstempel_tsa_passwort'), '');

  netzVersuche.length = 0;
  const f2Job = u.db.prepare("SELECT id FROM jobs WHERE dateiname = 'Rechnung zur Freigabe 2.pdf'").get().id;
  u.sitzung.testmodus = { personId: 'test-2' };
  const formular = await u.agent.get(`/freigabe2/${f2Job}`);
  assert.equal((await u.agent.post(`/freigabe2/${f2Job}`).type('form').send({ interessenskonflikt: 'nein', begruendung: '', _csrf: csrfAus(formular.text) })).status, 302);
  assert.equal(u.db.prepare('SELECT status FROM jobs WHERE id = ?').get(f2Job).status, 'abgeschlossen');
  u.sitzung.testmodus = { personId: 'test-4' };
  const token = csrfAus((await u.agent.get('/admin/geplante-jobs')).text);
  assert.equal((await u.agent.post('/admin/geplante-jobs/zeitstempel-nachholen/jetzt-ausfuehren').type('form').send({ _csrf: token })).status, 302);
  assert.deepEqual(netzVersuche, []);
  u.aufraeumen();
});

test('ChurchTools-Test, Personen-Sync und Kernjobs rufen ChurchTools im Testmodus nicht auf', async () => {
  const u = await umgebung();
  u.sitzung.testmodus = { personId: 'test-4' };
  netzVersuche.length = 0;
  const token = csrfAus((await u.agent.get('/admin/ersteinrichtung')).text);
  assert.equal((await u.agent.post('/admin/ersteinrichtung/churchtools-test').type('form').send({ _csrf: token })).status, 302);
  assert.equal((await u.agent.post('/admin/ersteinrichtung/jobs').type('form').send({ _csrf: token })).status, 302);
  assert.equal((await u.agent.post('/admin/geplante-jobs/sync-personen/jetzt-ausfuehren').type('form').send({ _csrf: token })).status, 302);
  assert.match((await u.agent.get('/admin/ersteinrichtung')).text, /Im Testmodus deaktiviert/);
  assert.deepEqual(netzVersuche, []);
  // Beispielpersonen bleiben bestehen (kein Sync hat sie deaktiviert).
  assert.equal(u.db.prepare('SELECT COUNT(*) c FROM personen WHERE aktiv = 1').get().c, 5);
  u.aufraeumen();
});

test('Maschinen-Routen antworten in der Test-Instanz mit 401, auch mit den echten Schlüsseln', async () => {
  const u = await umgebung();
  for (const [pfad, header, wert] of [
    ['/api/n8n/jobs/abholbereit', 'X-API-Key', N8N],
    ['/api/n8n/kk-belege/offen', 'X-API-Key', N8N],
    ['/api/n8n/backup/status', 'X-API-Key', BACKUP],
    ['/internal/cron/pool-erinnerungen', 'X-Cron-Secret', CRON],
  ]) {
    assert.equal((await request(u.aussen).get(pfad).set(header, wert)).status, 401, pfad);
    assert.equal((await request(u.aussen).post(pfad).set(header, wert)).status, 401, `POST ${pfad}`);
  }
  u.aufraeumen();
});

test('kein Login-Router und kein /healthz in der Test-Instanz', async () => {
  const u = await umgebung();
  assert.equal((await u.agent.get('/auth/login')).status, 404);
  assert.equal((await u.agent.get('/healthz')).status, 404);
  u.aufraeumen();
});

test('nur die bekannten Beispielpersonen; alles andere → 403', async () => {
  const u = await umgebung();
  // Auch Personen in der Spiel-DB mit test-Präfix oder Admin-Gruppe gelten nicht.
  upsertPerson(u.db, { id: 'test-6', vorname: 'Neu', nachname: 'Person', email: 'n@x.invalid', gruppen: ['test-admin', 'test-buchhaltung'] });
  upsertPerson(u.db, { id: 'echt-admin', vorname: 'Echt', nachname: 'Admin', email: 'e@x.invalid', gruppen: ['test-admin', 'test-buchhaltung'] });
  for (const testmodus of [{ personId: 'test-6' }, { personId: 'echt-admin' }, { personId: 'test-99' }, { personId: ['test-1'] }, {}]) {
    u.sitzung.testmodus = testmodus;
    const res = await u.agent.get('/pool');
    assert.equal(res.status, 403, JSON.stringify(testmodus));
    assert.doesNotMatch(res.text, /pool-row-/);
  }
  u.aufraeumen();
});

test('Dora (Admin der Test-Konfiguration) sieht den Admin-Bereich', async () => {
  const u = await umgebung();
  u.sitzung.testmodus.personId = 'test-4';
  const res = await u.agent.get('/admin');
  assert.equal(res.status, 200);
  assert.match(res.text, /Testmodus — nichts hier ist echt/);
  u.aufraeumen();
});

test('ChurchTools-Personenabruf liefert im Testmodus Beispiel-Zahlungsdaten ohne Netz', async () => {
  netzVersuche.length = 0;
  const { fetchPersonById, fetchGroup, TESTMODUS_IBAN } = await import('../../src/services/churchtools.js');
  const ct = { testmodus: true, baseUrl: 'https://testmodus.invalid', customFieldIban: 'iban', customFieldKontoinhaber: 'kontoinhaber' };
  const person = await fetchPersonById(ct, null, 'test-3');
  assert.equal(person.iban, TESTMODUS_IBAN);
  assert.equal(person.kontoinhaber, 'Beispielperson');
  await assert.rejects(fetchGroup(ct, null, 'test-admin'), /Testmodus/);
  assert.deepEqual(netzVersuche, []);
});
