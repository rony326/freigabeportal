// Verweigerte Zugriffe ueber die echte createApp-Verdrahtung (Session, CSRF, Rechte, API-Key):
// Protokollierung, Zuordnung zu Akteur/Request, Redaction, Drosselung und Audit-Ausfall.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/db/index.js';
import { createApp } from '../../src/app.js';
import { setBerechtigungenForPerson } from '../../src/db/personBerechtigungenRepo.js';
import { setupMockChurchTools } from '../helpers/mockChurchTools.js';
import { fetchCsrfToken } from '../helpers/csrf.js';
import { auditContext, auditRequestContext } from '../../src/services/auditContext.js';
import { zugriffsAuditMiddleware, zugriffsAuditFehlerStatus, EINZEL_PRO_SCHLUESSEL } from '../../src/services/zugriffsAudit.js';

const GEHEIM = 'GEHEIMNIS-4711';

function testConfig(dir) {
  return {
    sessionSecret: 'test-secret',
    env: 'test',
    churchtools: {
      baseUrl: 'https://ct.example.org', clientId: 'client-id', clientSecret: 'client-secret',
      redirectUri: 'https://portal.example.org/auth/callback', groupIdBuchhaltung: '10', groupIdAdmin: '20', syncServiceToken: 'token',
    },
    cronSecret: 'cron-secret',
    n8nApiKey: 'n8n-key',
    smtp: { host: 'smtp.example.org', port: 587, user: 'user', pass: 'pass', from: 'portal@example.org' },
    brandingDir: dir, jobsDir: dir, backupDir: dir, downloadSigningSecret: 'download-secret',
  };
}

async function loginAs(app, client, { id, gruppen }) {
  client.intercept({ path: '/oauth/access_token', method: 'POST' }).reply(200, { access_token: `tok-${id}` });
  client.intercept({ path: '/oauth/userinfo', method: 'GET' }).reply(200, { id, firstName: 'Vorname', lastName: `Person${id}`, email: `p${id}@example.org` });
  client.intercept({ path: '/api/groups/10/members', method: 'GET' }).reply(200, { data: gruppen.includes('10') ? [{ personId: id }] : [] });
  client.intercept({ path: '/api/groups/20/members', method: 'GET' }).reply(200, { data: gruppen.includes('20') ? [{ personId: id }] : [] });
  const agent = request.agent(app);
  const loginRes = await agent.get('/auth/login');
  const state = new URL(loginRes.headers.location).searchParams.get('state');
  const callbackRes = await agent.get('/auth/callback').query({ code: `code-${id}`, state });
  assert.equal(callbackRes.status, 302);
  return agent;
}

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'zugriff-audit-'));
  const db = openDatabase(':memory:');
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const config = testConfig(dir);
  return { db, config, app: createApp({ db, config }), client: setupMockChurchTools(config.churchtools.baseUrl) };
}

function denials(db) {
  return db.prepare(`SELECT e.*, r.request_id FROM audit_ereignisse e
    LEFT JOIN audit_request_zuordnung r ON r.ereignis_id = e.id
    WHERE e.objekt = 'zugriff' ORDER BY e.id`).all().map((row) => ({ ...row, daten: JSON.parse(row.nachher) }));
}

test('anonymous admin access is denied, recorded with request ID and without query, cookies or path IDs', async (t) => {
  const { db, app } = setup(t);
  const res = await request(app).get(`/admin/konten/12345/bearbeiten?token=${GEHEIM}`).set('Cookie', `connect.sid=${GEHEIM}`);
  assert.equal(res.status, 401);
  const [event] = denials(db);
  assert.equal(event.aktion, 'zugriff_verweigert');
  assert.equal(event.person_id, 'anonymous');
  assert.equal(event.objekt_id, '/admin/konten');
  assert.deepEqual(event.daten, { grund: 'nicht_angemeldet', status: 401, methode: 'GET', bereich: '/admin/konten' });
  assert.equal(event.request_id, res.headers['x-request-id']);
  assert.ok(!JSON.stringify(event).includes(GEHEIM));
  assert.ok(!JSON.stringify(event).includes('12345'));
});

test('missing role and missing permission are attributed to the logged-in person with the required right', async (t) => {
  const { db, app, client } = setup(t);
  const agent = await loginAs(app, client, { id: 7, gruppen: [] });
  assert.equal((await agent.get('/admin/konten')).status, 403);
  setBerechtigungenForPerson(db, '7', ['mails_einsehen']);
  assert.equal((await agent.get('/admin/konten')).status, 403);
  assert.equal((await agent.get('/admin/backup')).status, 403);
  const events = denials(db);
  assert.deepEqual(events.map((e) => [e.person_id, e.daten.grund, e.daten.recht ?? null, e.objekt_id]), [
    ['7', 'kein_adminbereich', null, '/admin/konten'],
    ['7', 'fehlendes_recht', 'konten_verwalten', '/admin/konten'],
    ['7', 'fehlende_rolle', null, '/admin/backup'],
  ]);
  assert.equal(events[1].person_name, 'Vorname Person7');
  // An authorised area is not recorded as denied and its outcome is unchanged.
  assert.equal((await agent.get('/admin/mails')).status, 200);
  assert.equal(denials(db).length, 3);
});

test('CSRF failure is recorded without the submitted token and without changing data', async (t) => {
  const { db, app, client } = setup(t);
  const agent = await loginAs(app, client, { id: 1, gruppen: ['10', '20'] });
  await fetchCsrfToken(agent, '/pool');
  const res = await agent.post('/admin/konten').type('form').send({ _csrf: GEHEIM, kontonummer: '4000', bezeichnung: 'Test' });
  assert.equal(res.status, 403);
  assert.match(res.text, /Sicherheitsprüfung fehlgeschlagen/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM konten').get().n, 0);
  const [event] = denials(db);
  assert.equal(event.person_id, '1');
  assert.deepEqual(event.daten, { grund: 'csrf', status: 403, methode: 'POST', bereich: '/admin/konten' });
  assert.ok(!JSON.stringify(event).includes(GEHEIM));
});

test('invalid machine credentials are recorded without the submitted key; valid key is not recorded', async (t) => {
  const { db, app } = setup(t);
  assert.equal((await request(app).get('/api/n8n/jobs/abholbereit').set('X-API-Key', GEHEIM)).status, 401);
  assert.equal((await request(app).post('/internal/cron/sync-personen').set('X-Cron-Secret', GEHEIM)).status, 401);
  const events = denials(db);
  assert.deepEqual(events.map((e) => [e.daten.grund, e.objekt_id]), [['api_key', '/api/n8n/jobs'], ['cron_secret', '/internal/cron']]);
  assert.ok(!JSON.stringify(events).includes(GEHEIM));
  await request(app).get('/api/n8n/jobs/abholbereit').set('X-API-Key', 'n8n-key');
  assert.equal(denials(db).length, 2);
});

test('repeated denials are throttled per window; unknown paths cannot create new keys', async (t) => {
  const { db, app } = setup(t);
  for (let i = 0; i < 10; i++) {
    assert.equal((await request(app).get(`/admin/zufall-${i}-${GEHEIM}`)).status, 401);
  }
  const events = denials(db);
  assert.equal(events.filter((e) => e.aktion === 'zugriff_verweigert').length, EINZEL_PRO_SCHLUESSEL);
  assert.equal(events.filter((e) => e.aktion === 'zugriff_verweigert_gedrosselt').length, 1);
  assert.ok(events.every((e) => e.objekt_id === '/admin'));
  const zaehler = db.prepare("SELECT anzahl FROM audit_zugriff_drosselung WHERE schluessel = 'nicht_angemeldet|/admin|anonymous'").get();
  assert.equal(zaehler.anzahl, 10);
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM audit_zugriff_drosselung').all()).includes(GEHEIM));
});

test('audit outage never grants access and leaves status and body of the denial unchanged', async (t) => {
  const { db, app, client } = setup(t);
  const vorher = await request(app).get('/admin/konten');
  db.exec("CREATE TRIGGER audit_ausfall BEFORE INSERT ON audit_ereignisse WHEN NEW.objekt = 'zugriff' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;");
  const fehlerVorher = zugriffsAuditFehlerStatus().fehlerAnzahl;
  const originalError = console.error;
  const meldungen = [];
  console.error = (...args) => meldungen.push(args.join(' '));
  try {
    const nachher = await request(app).get(`/admin/konten?x=${GEHEIM}`);
    assert.equal(nachher.status, 401);
    assert.equal(nachher.text, vorher.text.replace(vorher.headers['x-request-id'], nachher.headers['x-request-id']));
    const agent = await loginAs(app, client, { id: 8, gruppen: [] });
    assert.equal((await agent.get('/admin/konten')).status, 403);
    const admin = await loginAs(app, client, { id: 9, gruppen: ['20'] });
    assert.equal((await admin.get('/admin/konten')).status, 200);
  } finally { console.error = originalError; }
  assert.equal(zugriffsAuditFehlerStatus().fehlerAnzahl, fehlerVorher + 2);
  assert.ok(meldungen.every((m) => !m.includes(GEHEIM)));
  assert.equal(denials(db).length, 1);
  // The failed audit attempt is rolled back completely, including its throttling counters.
  assert.equal(db.prepare('SELECT sum(anzahl) AS n FROM audit_zugriff_drosselung WHERE schluessel NOT LIKE \'#%\'').get().n, 1);
});

test('route-level 403 is captured by the finish fallback with actor and request correlation', async (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const app = express();
  app.use(auditRequestContext);
  app.use((req, res, next) => { req.currentPerson = { churchtools_person_id: '42', vorname: 'Ada', nachname: 'Test' }; next(); });
  app.use(auditContext);
  app.use(zugriffsAuditMiddleware(db));
  app.get('/kontierung/:id', (req, res) => setTimeout(() => res.status(403).send('fremder Beleg'), 5));
  app.get('/pool', (req, res) => res.send('ok'));
  const res = await request(app).get('/kontierung/99');
  assert.equal(res.status, 403);
  for (let i = 0; i < 20 && denials(db).length === 0; i++) await new Promise((resolve) => setImmediate(resolve));
  const [event] = denials(db);
  assert.equal(event.person_id, '42');
  assert.equal(event.request_id, res.headers['x-request-id']);
  assert.deepEqual(event.daten, { grund: 'objekt_verweigert', status: 403, methode: 'GET', bereich: '/kontierung' });
  await request(app).get('/pool');
  assert.equal(denials(db).length, 1);
});
