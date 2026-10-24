import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupMockChurchTools } from '../helpers/mockChurchTools.js';
import { openDatabase } from '../../src/db/index.js';
import { createApp } from '../../src/app.js';

function testConfig() {
  return {
    sessionSecret: 'test-secret',
    env: 'test',
    cronSecret: 'cron-secret',
    n8nApiKey: 'n8n-key',
    churchtools: {
      baseUrl: 'https://ct.example.org',
      clientId: 'id',
      clientSecret: 'secret',
      redirectUri: 'https://portal.example.org/auth/callback',
      groupIdBuchhaltung: '10',
      groupIdAdmin: '20',
      syncServiceToken: 'token',
    },
  };
}

test('an unmatched route returns a German 404 page', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, config: testConfig() });
  const res = await request(app).get('/does-not-exist');
  assert.equal(res.status, 404);
  assert.match(res.text, /nicht gefunden/);
  db.close();
});

test('a ChurchTools failure mid-callback is caught and rendered as a German 500 page', async () => {
  const config = testConfig();
  const client = setupMockChurchTools(config.churchtools.baseUrl);
  client.intercept({ path: '/oauth/access_token', method: 'POST' }).reply(500, {});

  const db = openDatabase(':memory:');
  const app = createApp({ db, config });
  const agent = request.agent(app);
  const loginRes = await agent.get('/auth/login');
  const state = new URL(loginRes.headers.location).searchParams.get('state');

  const res = await agent.get('/auth/callback').query({ code: 'the-code', state });
  assert.equal(res.status, 500);
  assert.match(res.text, /unerwarteter Fehler/);
  db.close();
});

test('malformed JSON body throws before body/session middleware runs, and still renders the German error page (not the Express default)', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, config: testConfig() });
  const res = await request(app)
    .post('/healthz')
    .set('Content-Type', 'application/json')
    .send('{bad json');
  assert.equal(res.status, 500);
  assert.match(res.text, /unerwarteter Fehler/);
  // Express's default error handler would emit an HTML page containing the
  // raw error stack / "Error:" prefix and no German copy at all — make sure
  // we didn't fall through to that.
  assert.doesNotMatch(res.text, /<pre>/);
  db.close();
});

test('500 erfasst Fehler mit Request-ID und Stack, Fehlerseite zeigt 8-stellige ID ohne Stack', async (t) => {
  t.mock.method(console, 'error', () => {});
  const db = openDatabase(':memory:');
  const app = createApp({ db, config: testConfig() });
  const res = await request(app)
    .post('/healthz?token=geheim')
    .set('Content-Type', 'application/json')
    .set('User-Agent', 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0')
    .send('{bad json');
  assert.equal(res.status, 500);
  const requestId = res.headers['x-request-id'];
  const rows = db.prepare('SELECT * FROM betrieb_fehler').all();
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.request_id, requestId);
  assert.equal(row.status, 500);
  assert.equal(row.methode, 'POST');
  assert.equal(row.pfad, '/healthz');
  assert.equal(row.person_id, null);
  assert.match(row.stack, /\n\s+at /);
  assert.match(row.user_agent, /Firefox\/131/);
  assert.ok(res.text.includes(`Fehler-ID: <code>${requestId.slice(0, 8)}</code>`));
  assert.ok(!res.text.includes(requestId), 'nur die ersten 8 Zeichen werden angezeigt');
  assert.doesNotMatch(res.text, /\bat \S+ \(|node_modules/);
  assert.doesNotMatch(res.text, /fehler-melden/, 'ohne Anmeldung kein Melde-Formular');
  db.close();
});

test('Fehlerseite bietet angemeldeten Personen das Melde-Formular mit CSRF-Token', async (t) => {
  t.mock.method(console, 'error', () => {});
  const config = testConfig();
  const client = setupMockChurchTools(config.churchtools.baseUrl);
  client.intercept({ path: '/oauth/access_token', method: 'POST' }).reply(200, { access_token: 'tok' });
  client.intercept({ path: '/oauth/userinfo', method: 'GET' }).reply(200, { id: '42', firstName: 'A', lastName: 'B', email: 'a@example.org' });
  client.intercept({ path: '/api/groups/10/members', method: 'GET' }).reply(200, { data: [] });
  client.intercept({ path: '/api/groups/20/members', method: 'GET' }).reply(200, { data: [] });
  const db = openDatabase(':memory:');
  const app = createApp({ db, config });
  const agent = request.agent(app);
  const loginRes = await agent.get('/auth/login');
  const state = new URL(loginRes.headers.location).searchParams.get('state');
  assert.equal((await agent.get('/auth/callback').query({ code: 'c', state })).status, 302);

  // Kaputte Datenbank-Tabelle: die Seite scheitert mit 500, die Person bleibt angemeldet.
  db.exec('DROP TABLE jobs');
  const res = await agent.get('/pool');
  assert.equal(res.status, 500);
  const kurzId = res.headers['x-request-id'].slice(0, 8);
  const row = db.prepare('SELECT * FROM betrieb_fehler').get();
  assert.equal(row.person_id, '42');
  const form = res.text.match(/<form[^>]*action="\/fehler-melden"[\s\S]*?<\/form>/);
  assert.ok(form, 'Melde-Formular fehlt');
  assert.match(form[0], /method="post"/);
  assert.match(form[0], /name="_csrf" value="[^"]+"/);
  assert.match(form[0], new RegExp(`name="fehlerId" value="${kurzId}"`));
  assert.match(form[0], /<textarea[^>]*name="beschreibung"/);
  assert.match(form[0], /Fehler melden/);
  db.close();
});

test('404 erzeugt keinen Fehler-Eintrag', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, config: testConfig() });
  const res = await request(app).get('/does-not-exist');
  assert.equal(res.status, 404);
  assert.doesNotMatch(res.text, /Fehler-ID/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM betrieb_fehler').get().n, 0);
  db.close();
});
