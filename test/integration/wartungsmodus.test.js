import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/db/index.js';
import { createApp } from '../../src/app.js';
import { setupMockChurchTools } from '../helpers/mockChurchTools.js';
import { fetchCsrfToken } from '../helpers/csrf.js';
import { setzeWartungsmodus } from '../../src/services/wartungsmodus.js';
import { setGruppenBerechtigungen } from '../../src/db/gruppenBerechtigungenRepo.js';

function testConfig(brandingDir) {
  return {
    sessionSecret: 'test-secret',
    env: 'test',
    churchtools: {
      baseUrl: 'https://ct.example.org',
      clientId: 'id',
      clientSecret: 'secret',
      redirectUri: 'https://portal.example.org/auth/callback',
      groupIdBuchhaltung: '10',
      groupIdAdmin: '20',
      groupIdManager: '30',
      syncServiceToken: 'token',
    },
    cronSecret: 'cron-secret',
    n8nApiKey: 'n8n-key',
    smtp: { host: 'smtp.example.org', port: 587, user: 'user', pass: 'pass', from: 'portal@example.org' },
    brandingDir,
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
  client
    .intercept({ path: '/api/groups/30/members', method: 'GET' })
    .reply(200, { data: gruppen.includes('30') ? [{ personId: id }] : [] });

  const agent = request.agent(app);
  const loginRes = await agent.get('/auth/login');
  const state = new URL(loginRes.headers.location).searchParams.get('state');
  const callbackRes = await agent.get('/auth/callback').query({ code: `code-${id}`, state });
  assert.equal(callbackRes.status, 302, `login for person ${id} should succeed`);
  return agent;
}



function setup(t) {
  const db = openDatabase(':memory:');
  const brandingDir = mkdtempSync(join(tmpdir(), 'branding-test-'));
  const config = testConfig(brandingDir);
  const app = createApp({ db, config });
  const client = setupMockChurchTools(config.churchtools.baseUrl);
  t.after(() => { db.close(); rmSync(brandingDir, { recursive: true, force: true }); });
  return { db, app, client, config };
}

test('Modus aus: alles wie vorher', async (t) => {
  const { app, client } = setup(t);
  const agent = await loginAs(app, client, { id: 7, vorname: 'Normal', nachname: 'User', email: 'n@example.org', gruppen: ['10'] });
  assert.notEqual((await agent.get('/pool')).status, 503);
});

test('Modus an: normale Person sieht die Wartungsseite mit Hinweis (503)', async (t) => {
  const { db, app, client } = setup(t);
  const agent = await loginAs(app, client, { id: 7, vorname: 'Normal', nachname: 'User', email: 'n@example.org', gruppen: ['10'] });
  setzeWartungsmodus(db, true, 'Update bis 14:00');
  const res = await agent.get('/pool');
  assert.equal(res.status, 503);
  assert.match(res.text, /Wartungsarbeiten/);
  assert.match(res.text, /Update bis 14:00/);
  assert.ok(res.headers['retry-after']);
});

test('Modus an: ohne Session ebenfalls 503 (kein Redirect-Loop), Login und /healthz bleiben erreichbar', async (t) => {
  const { db, app } = setup(t);
  setzeWartungsmodus(db, true);
  assert.equal((await request(app).get('/pool')).status, 503);
  assert.equal((await request(app).get('/')).status, 503);
  const login = await request(app).get('/auth/login');
  assert.equal(login.status, 302);
  assert.match(login.headers.location, /oauth\/authorize/);
  assert.equal((await request(app).get('/healthz')).status, 200);
});

test('Modus an: Person mit Recht wartungsmodus_schalten arbeitet weiter und sieht den Banner', async (t) => {
  const { db, app, client } = setup(t);
  const agent = await loginAs(app, client, { id: 99, vorname: 'Admina', nachname: 'Portal', email: 'a@example.org', gruppen: ['20'] });
  setzeWartungsmodus(db, true);
  const res = await agent.get('/pool');
  assert.equal(res.status, 200);
  assert.match(res.text, /Wartungsmodus aktiv/);
  assert.match(res.text, /\/admin\/wartungsmodus/);
});

test('Modus an: Entzug des Rechts sperrt den Admin sofort aus', async (t) => {
  const { db, app, client } = setup(t);
  const agent = await loginAs(app, client, { id: 99, vorname: 'Admina', nachname: 'Portal', email: 'a@example.org', gruppen: ['20'] });
  setzeWartungsmodus(db, true);
  setGruppenBerechtigungen(db, 'superadmin', ['konten_verwalten']);
  assert.equal((await agent.get('/pool')).status, 503);
});

test('Modus an: n8n-Eingang und Cron antworten 503 mit Retry-After, Backup-Route bleibt offen', async (t) => {
  const { db, app } = setup(t);
  setzeWartungsmodus(db, true);
  const jobs = await request(app).post('/api/n8n/jobs').set('X-API-Key', 'n8n-key');
  assert.equal(jobs.status, 503);
  assert.ok(jobs.headers['retry-after']);
  assert.equal(jobs.body.error, 'wartungsmodus');
  assert.equal((await request(app).get('/api/n8n/jobs/abholbereit').set('X-API-Key', 'n8n-key')).status, 503);
  assert.equal((await request(app).post('/api/n8n/kk-belege').set('X-API-Key', 'n8n-key')).status, 503);
  assert.equal((await request(app).get('/api/n8n/rapporte/abholbereit').set('X-API-Key', 'n8n-key')).status, 503);
  assert.equal((await request(app).post('/internal/cron/sync-personen').set('X-Cron-Secret', 'cron-secret')).status, 503);
  assert.notEqual((await request(app).get('/api/n8n/backup/latest').set('X-API-Key', 'n8n-key')).status, 503);
});

test('Modus an: «Erneut versenden» im Mail-Protokoll sendet nichts und zeigt einen Hinweis', async (t) => {
  const { db, app, client } = setup(t);
  const agent = await loginAs(app, client, { id: 99, vorname: 'Admina', nachname: 'Portal', email: 'a@example.org', gruppen: ['20'] });
  db.prepare(`INSERT INTO mail_log (typ, empfaenger, betreff, text, status, versucht_am) VALUES ('testmail', 'x@example.org', 'B', 'T', 'fehlgeschlagen', ?)`).run(new Date().toISOString());
  const id = db.prepare('SELECT id FROM mail_log').get().id;
  setzeWartungsmodus(db, true);
  const token = await fetchCsrfToken(agent, '/admin/mails');
  const res = await agent.post(`/admin/mails/${id}/erneut-versenden`).type('form').send({ _csrf: token });
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /zurueckgehalten=1/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM mail_log').get().n, 1);
  const seite = await agent.get('/admin/mails?zurueckgehalten=1');
  assert.match(seite.text, /Wartungsmodus/);
});
