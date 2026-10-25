// Testmodus-Weiche in der echten App: Sitzungen mit eingeschaltetem Testmodus landen in der
// Test-Instanz (Spiel-DB), alles andere bleibt echt. Plus Admin-Seite /admin/testmodus.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/db/index.js';
import { seedDefaults } from '../../src/db/adminConfigRepo.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createJob } from '../../src/db/jobsRepo.js';
import { setBerechtigungenForPerson } from '../../src/db/personBerechtigungenRepo.js';
import { createApp } from '../../src/app.js';
import { createTestMailer } from '../../src/services/testmodus/testMailer.js';
import { setupMockChurchTools } from '../helpers/mockChurchTools.js';
import { buildPdfFixture } from '../helpers/pdfFixture.js';

const ADMIN = { id: 1, vorname: 'Echt', nachname: 'Admin', email: 'admin@example.org', gruppen: ['10', '20'] };
const MANAGER = { id: 2, vorname: 'Echt', nachname: 'Manager', email: 'manager@example.org', gruppen: ['30'] };
const BUCHHALTUNG = { id: 3, vorname: 'Echt', nachname: 'Buchhaltung', email: 'bh@example.org', gruppen: ['10'] };
const ZWEITER_ADMIN = { id: 4, vorname: 'Zweite', nachname: 'Adminin', email: 'admin2@example.org', gruppen: ['10', '20'] };

async function umgebung({ dbPath = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'testmodus-weiche-'));
  const config = {
    env: 'test',
    sessionSecret: 'test-secret',
    dbPath: dbPath ?? join(dir, 'echt.sqlite'),
    jobsDir: join(dir, 'jobs'), brandingDir: join(dir, 'branding'), backupDir: join(dir, 'backups'),
    downloadSigningSecret: 'download-secret',
    n8nApiKey: 'n'.repeat(32), cronSecret: 'c'.repeat(32), backupApiKey: 'b'.repeat(32),
    smtp: null,
    churchtools: {
      baseUrl: 'https://ct.example.org', clientId: 'client-id', clientSecret: 'client-secret',
      redirectUri: 'https://portal.example.org/auth/callback', syncServiceToken: 'token',
      groupIdBuchhaltung: '10', groupIdAdmin: '20', groupIdManager: '30',
      customFieldIban: 'iban', customFieldKontoinhaber: 'kontoinhaber',
    },
  };
  for (const d of [config.jobsDir, config.brandingDir, config.backupDir]) mkdirSync(d, { recursive: true });
  const echteDb = openDatabase(dbPath ?? config.dbPath);
  seedDefaults(echteDb);
  // Genug echte Pool-Belege, damit jede Spielwiesen-ID auch in der echten DB existiert.
  const pdf = join(config.jobsDir, 'echt.pdf');
  writeFileSync(pdf, await buildPdfFixture(['Echte Rechnung']));
  for (let i = 0; i < 30; i++) {
    createJob(echteDb, { eingangAm: new Date().toISOString(), quelle: 'scanner', absender: `Echter Lieferant ${i}`, dateiname: `Echter-Beleg-${i}.pdf`, pdfPfad: pdf, dateiHash: `echt-${i}` });
  }
  const app = createApp({ db: echteDb, config, mailer: createTestMailer() });
  const ct = setupMockChurchTools(config.churchtools.baseUrl);
  const steuerung = app.get('testmodusSteuerung');
  const aufraeumen = async () => {
    await steuerung.schliessen();
    echteDb.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, config, echteDb, app, ct, steuerung, aufraeumen };
}

async function anmelden(u, person) {
  const { id, vorname, nachname, email, gruppen } = person;
  u.ct.intercept({ path: '/oauth/access_token', method: 'POST' }).reply(200, { access_token: `tok-${id}` });
  u.ct.intercept({ path: '/oauth/userinfo', method: 'GET' }).reply(200, { id, firstName: vorname, lastName: nachname, email });
  for (const g of ['10', '20', '30']) {
    u.ct.intercept({ path: `/api/groups/${g}/members`, method: 'GET' }).reply(200, { data: gruppen.includes(g) ? [{ personId: id }] : [] });
  }
  const agent = request.agent(u.app);
  const login = await agent.get('/auth/login');
  const state = new URL(login.headers.location).searchParams.get('state');
  const cb = await agent.get('/auth/callback').query({ code: `code-${id}`, state });
  assert.equal(cb.status, 302, `Anmeldung ${id}`);
  return agent;
}

// Erstes _csrf-Feld nach einer Formular-Action (oder das erste überhaupt).
function csrf(text, action = null) {
  const ab = action ? text.indexOf(`action="${action}"`) : 0;
  assert.ok(ab >= 0, `Formular ${action} nicht gefunden`);
  return text.slice(ab).match(/name="_csrf" value="([^"]*)"/)[1];
}

// Seitentoken der Test-Instanz (Formularfelder im Inhalt, nicht im Band/Kopf).
function seitenCsrf(text) {
  const kopf = text.match(/'X-CSRF-Token': '([^']+)'/);
  if (kopf) return kopf[1];
  const main = text.indexOf('<main');
  return text.slice(main).match(/name="_csrf" value="([^"]+)"/)[1];
}

async function einschalten(agent) {
  const seite = await agent.get('/admin/testmodus');
  assert.equal(seite.status, 200);
  const res = await agent.post('/admin/testmodus/ein').type('form').send({ _csrf: csrf(seite.text, '/admin/testmodus/ein') });
  assert.equal(res.status, 302, `Einschalten: ${res.status} ${res.text?.slice(0, 200)}`);
  return res;
}

const testmodusAudit = (db) => db.prepare("SELECT aktion, person_id, nachher FROM audit_ereignisse WHERE objekt = 'testmodus' ORDER BY id").all();
const BAND = 'Testmodus — nichts hier ist echt';

test('Einschalten nur für Superadmin und Manager; Buchhaltung bekommt 403 und bleibt echt', async () => {
  const u = await umgebung();
  const bh = await anmelden(u, BUCHHALTUNG);
  const tokenBh = csrf((await bh.get('/pool')).text);
  assert.equal((await bh.get('/admin/testmodus')).status, 403);
  assert.equal((await bh.post('/admin/testmodus/ein').type('form').send({ _csrf: tokenBh })).status, 403);
  const pool = await bh.get('/pool');
  assert.ok(!pool.text.includes(BAND));
  assert.equal(testmodusAudit(u.echteDb).length, 0);

  const manager = await anmelden(u, MANAGER);
  await einschalten(manager);
  const mPool = await manager.get('/pool');
  assert.equal(mPool.status, 200);
  assert.ok(mPool.text.includes(BAND));
  assert.match(mPool.text, /Angemeldet als Dora Beispiel/);
  await u.aufraeumen();
});

test('Testmodus an: /pool zeigt Spielwiese; /admin/testmodus, /healthz und /admin/betrieb/status bleiben echt; zweite Sitzung sieht echte Daten', async () => {
  const u = await umgebung();
  const admin = await anmelden(u, ADMIN);
  const ein = await einschalten(admin);
  assert.equal(ein.headers.location, '/pool');

  const pool = await admin.get('/pool');
  assert.equal(pool.status, 200);
  assert.ok(pool.text.includes(BAND));
  assert.ok(pool.text.includes('Angemeldet als Dora Beispiel'));
  assert.ok(!pool.text.includes('Echter Lieferant'));

  const seite = await admin.get('/admin/testmodus');
  assert.equal(seite.status, 200);
  assert.ok(!seite.text.includes(BAND));
  assert.match(seite.text, /Angemeldet als Echt Admin/);
  assert.match(seite.text, /Testmodus ist eingeschaltet/);

  const healthz = await admin.get('/healthz');
  assert.ok(!String(healthz.text).includes(BAND));
  assert.notEqual(healthz.status, 404);
  const status = await admin.get('/admin/betrieb/status');
  assert.equal(status.status, 200);
  assert.ok(!status.text.includes(BAND));
  assert.match(status.text, /Angemeldet als Echt Admin/);

  const zweite = await anmelden(u, ZWEITER_ADMIN);
  const zPool = await zweite.get('/pool');
  assert.ok(!zPool.text.includes(BAND));
  assert.ok(zPool.text.includes('Echter Lieferant'));
  assert.ok(!zPool.text.includes('Angemeldet als Dora Beispiel'));

  const audit = testmodusAudit(u.echteDb);
  assert.deepEqual(audit.map((a) => [a.aktion, a.person_id]), [['eingeschaltet', '1']]);
  const sandbox = (await u.steuerung.hole()).db;
  assert.equal(sandbox.prepare("SELECT COUNT(*) c FROM audit_ereignisse WHERE objekt = 'testmodus'").get().c, 0);
  await u.aufraeumen();
});

test('Ausschalten auf der Admin-Seite: danach echte Daten, Audit im echten Log', async () => {
  const u = await umgebung();
  const admin = await anmelden(u, ADMIN);
  await einschalten(admin);
  const seite = await admin.get('/admin/testmodus');
  const aus = await admin.post('/admin/testmodus/aus').type('form').send({ _csrf: csrf(seite.text, '/admin/testmodus/aus') });
  assert.equal(aus.status, 302);
  const pool = await admin.get('/pool');
  assert.ok(!pool.text.includes(BAND));
  assert.ok(pool.text.includes('Echter Lieferant'));
  assert.deepEqual(testmodusAudit(u.echteDb).map((a) => a.aktion), ['eingeschaltet', 'ausgeschaltet']);
  await u.aufraeumen();
});

test('Band-Formulare aus einer Seite der Test-Instanz werden von der echten App angenommen', async () => {
  const u = await umgebung();
  const admin = await anmelden(u, ADMIN);
  await einschalten(admin);
  const pool = await admin.get('/pool');
  const bandToken = csrf(pool.text, '/admin/testmodus/person');
  assert.ok(bandToken.length > 0, 'Band trägt ein echtes Token');

  const wechsel = await admin.post('/admin/testmodus/person').type('form').send({ _csrf: bandToken, personId: 'test-2' });
  assert.equal(wechsel.status, 302);
  const ben = await admin.get('/pool');
  assert.match(ben.text, /Angemeldet als Ben Beispiel/);

  // Unbekannte Person: abgelehnt, Person bleibt.
  const falsch = await admin.post('/admin/testmodus/person').type('form').send({ _csrf: csrf(ben.text, '/admin/testmodus/person'), personId: 'echt-1' });
  assert.equal(falsch.status, 400);
  assert.match((await admin.get('/pool')).text, /Angemeldet als Ben Beispiel/);

  const aus = await admin.post('/admin/testmodus/aus').type('form').send({ _csrf: csrf(ben.text, '/admin/testmodus/aus') });
  assert.equal(aus.status, 302);
  assert.ok(!(await admin.get('/pool')).text.includes(BAND));

  const audit = testmodusAudit(u.echteDb);
  assert.deepEqual(audit.map((a) => a.aktion), ['eingeschaltet', 'person_gewechselt', 'ausgeschaltet']);
  assert.equal(JSON.parse(audit[1].nachher).personId, 'test-2');
  await u.aufraeumen();
});

test('Abmelden aus dem Testmodus funktioniert (Kopf-Formular) und beendet den Testmodus', async () => {
  const u = await umgebung();
  const admin = await anmelden(u, ADMIN);
  await einschalten(admin);
  const pool = await admin.get('/pool');
  const res = await admin.post('/auth/logout').type('form').send({ _csrf: csrf(pool.text, '/auth/logout') });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/auth/abgemeldet');
  assert.equal((await admin.get('/pool')).status, 401);
  assert.deepEqual(testmodusAudit(u.echteDb).map((a) => a.aktion), ['eingeschaltet', 'ausgeschaltet']);
  // Neue Anmeldung: nicht im Testmodus.
  const wieder = await anmelden(u, ADMIN);
  assert.ok(!(await wieder.get('/pool')).text.includes(BAND));
  await u.aufraeumen();
});

test('Beanspruchen (/api/pool) im Testmodus ändert nur die Spiel-DB', async () => {
  const u = await umgebung();
  const admin = await anmelden(u, ADMIN);
  await einschalten(admin);
  const sandbox = (await u.steuerung.hole()).db;
  const job = sandbox.prepare("SELECT id FROM jobs WHERE dateiname = 'Rechnung im Pool.pdf'").get();
  const echtVorher = u.echteDb.prepare('SELECT * FROM jobs WHERE id = ?').get(job.id);
  assert.equal(echtVorher.status, 'unzugewiesen');
  const token = seitenCsrf((await admin.get('/pool')).text);
  const res = await admin.post(`/api/pool/${job.id}/beanspruchen`).set('x-csrf-token', token);
  assert.equal(res.status, 200);
  assert.equal(sandbox.prepare('SELECT status FROM jobs WHERE id = ?').get(job.id).status, 'zugewiesen');
  assert.deepEqual(u.echteDb.prepare('SELECT * FROM jobs WHERE id = ?').get(job.id), echtVorher);
  await u.aufraeumen();
});

test('Formular aus dem Testmodus nach dem Ausschalten verändert die echte DB nicht', async () => {
  const u = await umgebung();
  const admin = await anmelden(u, ADMIN);
  await einschalten(admin);
  const sandbox = (await u.steuerung.hole()).db;
  const job = sandbox.prepare("SELECT id FROM jobs WHERE dateiname = 'Rechnung im Pool.pdf'").get();
  const testToken = seitenCsrf((await admin.get('/pool')).text);
  // Im Testmodus beanspruchen, Kontierungsformular laden.
  assert.equal((await admin.post(`/api/pool/${job.id}/beanspruchen`).set('x-csrf-token', testToken)).status, 200);
  const formular = await admin.get(`/kontierung/${job.id}`);
  assert.equal(formular.status, 200);
  const formToken = seitenCsrf(formular.text);
  // Ausschalten, dann das alte Formular abschicken.
  const seite = await admin.get('/admin/testmodus');
  await admin.post('/admin/testmodus/aus').type('form').send({ _csrf: csrf(seite.text, '/admin/testmodus/aus') });
  // Echten Beleg mit derselben ID der echten Person zuweisen, damit nur die Prüfung schützt.
  u.echteDb.prepare("UPDATE jobs SET status = 'zugewiesen', zugewiesen_an = '1' WHERE id = ?").run(job.id);
  const vorher = u.echteDb.prepare('SELECT * FROM jobs WHERE id = ?').get(job.id);
  const zaehlen = () => ['freigaben', 'audit_ereignisse', 'mail_log'].map((t) => u.echteDb.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c);
  const zVorher = zaehlen();
  const res = await admin.post(`/kontierung/${job.id}`).type('form').send({
    kontoId: '1', kreditorId: '1', absender: 'X', rechnungsnummer: 'R1', betrag: '10.00', zahlungsziel: '2026-12-31',
    interessenskonflikt: 'nein', begruendung: '', _csrf: formToken,
  });
  assert.equal(res.status, 403);
  assert.match(res.text, /Sicherheitsprüfung fehlgeschlagen/);
  assert.deepEqual(u.echteDb.prepare('SELECT * FROM jobs WHERE id = ?').get(job.id), vorher);
  // Nur das Zugriffs-Audit der Ablehnung (csrf) darf dazukommen.
  const zNachher = zaehlen();
  assert.equal(zNachher[0], zVorher[0]);
  assert.equal(zNachher[2], zVorher[2]);
  await u.aufraeumen();
});

test('Anfragen im Testmodus (auch 403) landen nicht in Nutzungsdaten oder Zugriffs-Audit der echten App', async () => {
  const u = await umgebung();
  const admin = await anmelden(u, ADMIN);
  await einschalten(admin);
  const zaehlen = () => ['nutzung_seitenaufrufe', 'audit_ereignisse'].map((t) => u.echteDb.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c);
  const vorher = zaehlen();
  assert.equal((await admin.get('/pool')).status, 200);
  // Als Anna (keine Admin-Rolle in der Spielwiese) → 403 in der Test-Instanz.
  const pool = await admin.get('/pool');
  await admin.post('/admin/testmodus/person').type('form').send({ _csrf: csrf(pool.text, '/admin/testmodus/person'), personId: 'test-1' });
  const nachWechsel = zaehlen();
  assert.equal(nachWechsel[0], vorher[0], 'POST mit Redirect ist kein Seitenaufruf');
  assert.equal(nachWechsel[1], vorher[1] + 1, 'nur der Personenwechsel im Audit');
  assert.equal((await admin.get('/admin/module')).status, 403);
  assert.equal((await admin.get('/meine-spesen')).status, 200);
  assert.deepEqual(zaehlen(), nachWechsel);
  const sandbox = (await u.steuerung.hole()).db;
  assert.ok(sandbox.prepare("SELECT COUNT(*) c FROM audit_ereignisse WHERE objekt = 'zugriff'").get().c >= 1);
  await u.aufraeumen();
});

test('Verliert die Person die Admin-Rolle, löscht die Weiche das Flag und liefert die echte App', async () => {
  const u = await umgebung();
  const admin = await anmelden(u, ADMIN);
  await einschalten(admin);
  assert.ok((await admin.get('/pool')).text.includes(BAND));
  upsertPerson(u.echteDb, { id: '1', vorname: 'Echt', nachname: 'Admin', email: 'admin@example.org', gruppen: ['10'] });
  const pool = await admin.get('/pool');
  assert.ok(!pool.text.includes(BAND));
  assert.ok(pool.text.includes('Echter Lieferant'));
  // Rolle zurück: Flag bleibt gelöscht.
  upsertPerson(u.echteDb, { id: '1', vorname: 'Echt', nachname: 'Admin', email: 'admin@example.org', gruppen: ['10', '20'] });
  assert.ok(!(await admin.get('/pool')).text.includes(BAND));
  await u.aufraeumen();
});

test('Zurücksetzen: im Testmodus nur mit Bestätigung; stellt die Spielwiese neu her, schliesst die alte DB, Audit', async () => {
  const u = await umgebung();
  const admin = await anmelden(u, ADMIN);
  await einschalten(admin);
  const alt = await u.steuerung.hole();
  const job = alt.db.prepare("SELECT id FROM jobs WHERE dateiname = 'Rechnung im Pool.pdf'").get();
  const token = seitenCsrf((await admin.get('/pool')).text);
  assert.equal((await admin.post(`/api/pool/${job.id}/beanspruchen`).set('x-csrf-token', token)).status, 200);

  let seite = await admin.get('/admin/testmodus');
  const ohne = await admin.post('/admin/testmodus/zuruecksetzen').type('form').send({ _csrf: csrf(seite.text, '/admin/testmodus/zuruecksetzen') });
  assert.equal(ohne.status, 400);
  assert.equal(alt.db.prepare('SELECT status FROM jobs WHERE id = ?').get(job.id).status, 'zugewiesen');

  seite = await admin.get('/admin/testmodus');
  const mit = await admin.post('/admin/testmodus/zuruecksetzen').type('form').send({ _csrf: csrf(seite.text, '/admin/testmodus/zuruecksetzen'), bestaetigt: '1' });
  assert.equal(mit.status, 302);
  assert.equal(alt.db.isOpen, false, 'alte Spiel-DB geschlossen');
  const neu = await u.steuerung.hole();
  assert.notEqual(neu.db, alt.db);
  assert.equal(neu.db.prepare('SELECT status FROM jobs WHERE id = ?').get(job.id).status, 'unzugewiesen');
  // Testmodus bleibt an und läuft auf der neuen Spielwiese.
  const pool = await admin.get('/pool');
  assert.ok(pool.text.includes(BAND));
  assert.ok(pool.text.includes('Angemeldet als Dora Beispiel'));
  assert.deepEqual(testmodusAudit(u.echteDb).map((a) => a.aktion), ['eingeschaltet', 'zurueckgesetzt']);

  // Ohne Testmodus: ohne Bestätigung erlaubt.
  seite = await admin.get('/admin/testmodus');
  await admin.post('/admin/testmodus/aus').type('form').send({ _csrf: csrf(seite.text, '/admin/testmodus/aus') });
  seite = await admin.get('/admin/testmodus');
  const aus = await admin.post('/admin/testmodus/zuruecksetzen').type('form').send({ _csrf: csrf(seite.text, '/admin/testmodus/zuruecksetzen') });
  assert.equal(aus.status, 302);
  await u.aufraeumen();
});

test('Spielwiese nicht erstellbar (:memory:): klare Meldung, Testmodus bleibt aus, echte App läuft', async () => {
  const u = await umgebung({ dbPath: ':memory:' });
  const admin = await anmelden(u, ADMIN);
  const seite = await admin.get('/admin/testmodus');
  const res = await admin.post('/admin/testmodus/ein').type('form').send({ _csrf: csrf(seite.text, '/admin/testmodus/ein') });
  assert.equal(res.status, 503);
  assert.match(res.text, /Spielwiese konnte nicht erstellt werden/);
  const pool = await admin.get('/pool');
  assert.equal(pool.status, 200);
  assert.ok(!pool.text.includes(BAND));
  assert.ok(pool.text.includes('Echter Lieferant'));
  assert.equal(testmodusAudit(u.echteDb).length, 0);
  await u.aufraeumen();
});

test('Navigation: "Testmodus" unter Admin → Betrieb nur für Superadmin/Manager', async () => {
  const u = await umgebung();
  const admin = await anmelden(u, ADMIN);
  assert.match((await admin.get('/admin')).text, /href="\/admin\/testmodus"/);
  const manager = await anmelden(u, MANAGER);
  assert.match((await manager.get('/admin')).text, /href="\/admin\/testmodus"/);
  const bh = await anmelden(u, BUCHHALTUNG);
  setBerechtigungenForPerson(u.echteDb, '3', ['mails_einsehen']);
  const res = await bh.get('/admin/mails');
  assert.equal(res.status, 200);
  assert.doesNotMatch(res.text, /href="\/admin\/testmodus"/);
  await u.aufraeumen();
});
