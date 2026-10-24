import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupMockChurchTools } from '../helpers/mockChurchTools.js';
import { warteBis } from '../helpers/warteBis.js';
import { openDatabase } from '../../src/db/index.js';
import { createApp } from '../../src/app.js';
import { seedDefaults } from '../../src/db/adminConfigRepo.js';
import { getPersonById } from '../../src/db/personenRepo.js';
import { fetchCsrfToken, extractCookieValue } from '../helpers/csrf.js';

function testConfig() {
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
      syncServiceToken: 'sync-service-token',
    },
  };
}

test('GET /auth/login redirects to ChurchTools with a state parameter', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, config: testConfig() });
  const res = await request(app).get('/auth/login');
  assert.equal(res.status, 302);
  const location = new URL(res.headers.location);
  assert.equal(location.searchParams.get('client_id'), 'client-id');
  assert.ok(location.searchParams.get('state'));
  db.close();
});

test('GET /auth/callback rejects a mismatched state with a German error', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, config: testConfig() });
  const agent = request.agent(app);
  await agent.get('/auth/login');

  const res = await agent.get('/auth/callback').query({ code: 'x', state: 'wrong-state' });
  assert.equal(res.status, 400);
  assert.match(res.text, /Ungültiger Login-Vorgang/);
  db.close();
});

test('GET /auth/callback logs the person in and redirects straight to /pool for a Buchhaltung member', async () => {
  const config = testConfig();
  const client = setupMockChurchTools(config.churchtools.baseUrl);
  client.intercept({ path: '/oauth/access_token', method: 'POST' }).reply(200, { access_token: 'tok' });
  client
    .intercept({ path: '/oauth/userinfo', method: 'GET' })
    .reply(200, { id: 7, firstName: 'Max', lastName: 'Muster', email: 'max@example.org' });
  client.intercept({ path: '/api/groups/10/members', method: 'GET' }).reply(200, { data: [{ personId: 7 }] });
  client.intercept({ path: '/api/groups/20/members', method: 'GET' }).reply(200, { data: [] });

  const db = openDatabase(':memory:');
  const app = createApp({ db, config });
  const agent = request.agent(app);
  const loginRes = await agent.get('/auth/login');
  const state = new URL(loginRes.headers.location).searchParams.get('state');

  const res = await agent.get('/auth/callback').query({ code: 'the-code', state });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/pool');

  const person = getPersonById(db, '7');
  assert.equal(person.vorname, 'Max');
  assert.deepEqual(person.gruppen, ['10']);
  db.close();
});

test('GET /auth/callback also resolves Manager group membership when CT_GROUP_ID_MANAGER is configured', async () => {
  const config = testConfig();
  config.churchtools.groupIdManager = '30';
  const client = setupMockChurchTools(config.churchtools.baseUrl);
  client.intercept({ path: '/oauth/access_token', method: 'POST' }).reply(200, { access_token: 'tok' });
  client
    .intercept({ path: '/oauth/userinfo', method: 'GET' })
    .reply(200, { id: 7, firstName: 'Max', lastName: 'Muster', email: 'max@example.org' });
  client.intercept({ path: '/api/groups/10/members', method: 'GET' }).reply(200, { data: [] });
  client.intercept({ path: '/api/groups/20/members', method: 'GET' }).reply(200, { data: [] });
  client.intercept({ path: '/api/groups/30/members', method: 'GET' }).reply(200, { data: [{ personId: 7 }] });

  const db = openDatabase(':memory:');
  const app = createApp({ db, config });
  const agent = request.agent(app);
  const loginRes = await agent.get('/auth/login');
  const state = new URL(loginRes.headers.location).searchParams.get('state');
  const res = await agent.get('/auth/callback').query({ code: 'the-code', state });
  assert.equal(res.status, 302);
  assert.deepEqual(getPersonById(db, '7').gruppen, ['30']);
  db.close();
});

test('GET /auth/callback redirects a Portal-Admin (not also Buchhaltung) straight to /pool', async () => {
  const config = testConfig();
  const client = setupMockChurchTools(config.churchtools.baseUrl);
  client.intercept({ path: '/oauth/access_token', method: 'POST' }).reply(200, { access_token: 'tok' });
  client
    .intercept({ path: '/oauth/userinfo', method: 'GET' })
    .reply(200, { id: 20, firstName: 'Portal', lastName: 'Admin', email: 'portaladmin@example.org' });
  client.intercept({ path: '/api/groups/10/members', method: 'GET' }).reply(200, { data: [] });
  client.intercept({ path: '/api/groups/20/members', method: 'GET' }).reply(200, { data: [{ personId: 20 }] });

  const db = openDatabase(':memory:');
  const app = createApp({ db, config });
  const agent = request.agent(app);
  const loginRes = await agent.get('/auth/login');
  const state = new URL(loginRes.headers.location).searchParams.get('state');

  const res = await agent.get('/auth/callback').query({ code: 'the-code', state });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/pool');
  db.close();
});

test('GET /auth/callback resolves group membership using the sync service token, not the OAuth access token', async () => {
  // ChurchTools' OAuth2 access tokens are only valid against /oauth/* endpoints — a real request
  // to /api/groups/*/members with an OAuth access token gets a 403 from the live instance. This
  // test proves the login flow never even attempts that: the mock only accepts the sync service
  // token's Authorization header on the group-lookup calls, so a regression back to using
  // token.access_token would make the login flow fail with "no matching interceptor" here.
  const config = testConfig();
  const client = setupMockChurchTools(config.churchtools.baseUrl);
  client.intercept({ path: '/oauth/access_token', method: 'POST' }).reply(200, { access_token: 'oauth-access-token' });
  client
    .intercept({ path: '/oauth/userinfo', method: 'GET' })
    .reply(200, { id: 7, firstName: 'Max', lastName: 'Muster', email: 'max@example.org' });
  client
    .intercept({ path: '/api/groups/10/members', method: 'GET', headers: { authorization: 'Login sync-service-token' } })
    .reply(200, { data: [{ personId: 7 }] });
  client
    .intercept({ path: '/api/groups/20/members', method: 'GET', headers: { authorization: 'Login sync-service-token' } })
    .reply(200, { data: [] });

  const db = openDatabase(':memory:');
  const app = createApp({ db, config });
  const agent = request.agent(app);
  const loginRes = await agent.get('/auth/login');
  const state = new URL(loginRes.headers.location).searchParams.get('state');

  const res = await agent.get('/auth/callback').query({ code: 'the-code', state });
  assert.equal(res.status, 302);
  assert.deepEqual(getPersonById(db, '7').gruppen, ['10']);
  db.close();
});

test('GET /auth/callback regenerates the session on login (prevents session fixation)', async () => {
  const config = testConfig();
  const client = setupMockChurchTools(config.churchtools.baseUrl);
  client.intercept({ path: '/oauth/access_token', method: 'POST' }).reply(200, { access_token: 'tok' });
  client
    .intercept({ path: '/oauth/userinfo', method: 'GET' })
    .reply(200, { id: 8, firstName: 'Regen', lastName: 'Erate', email: 'regen@example.org' });
  client.intercept({ path: '/api/groups/10/members', method: 'GET' }).reply(200, { data: [{ personId: 8 }] });
  client.intercept({ path: '/api/groups/20/members', method: 'GET' }).reply(200, { data: [] });

  const db = openDatabase(':memory:');
  const app = createApp({ db, config });
  const agent = request.agent(app);
  const loginRes = await agent.get('/auth/login');
  const preLoginSid = extractCookieValue(loginRes.headers, 'connect.sid');
  const state = new URL(loginRes.headers.location).searchParams.get('state');

  const callbackRes = await agent.get('/auth/callback').query({ code: 'the-code', state });
  assert.equal(callbackRes.status, 302);
  const postLoginSid = extractCookieValue(callbackRes.headers, 'connect.sid');

  assert.notEqual(preLoginSid, postLoginSid, 'session ID must change on login, not just gain new data');

  const replayRes = await request(app).get('/pool').set('Cookie', `connect.sid=${preLoginSid}`);
  assert.equal(replayRes.status, 401, 'the pre-login session must not be authenticated, even if planted in a victim beforehand');
  db.close();
});

test('GET /auth/callback creates a session and a person even when the person belongs to no relevant group (AUTH-WIDEN-1)', async () => {
  const config = testConfig();
  const client = setupMockChurchTools(config.churchtools.baseUrl);
  client.intercept({ path: '/oauth/access_token', method: 'POST' }).reply(200, { access_token: 'tok' });
  client
    .intercept({ path: '/oauth/userinfo', method: 'GET' })
    .reply(200, { id: 42, firstName: 'Keine', lastName: 'Gruppe', email: 'keine@example.org' });
  client.intercept({ path: '/api/groups/10/members', method: 'GET' }).reply(200, { data: [] });
  client.intercept({ path: '/api/groups/20/members', method: 'GET' }).reply(200, { data: [] });

  const db = openDatabase(':memory:');
  const app = createApp({ db, config });
  const agent = request.agent(app);
  const loginRes = await agent.get('/auth/login');
  const state = new URL(loginRes.headers.location).searchParams.get('state');

  const res = await agent.get('/auth/callback').query({ code: 'the-code', state });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/pool');

  const person = getPersonById(db, '42');
  assert.ok(person, 'a person with no relevant group membership must still get a local session and a personen row');
  assert.deepEqual(person.gruppen, []);
  assert.equal(person.aktiv, true);
  db.close();
});

test('POST /auth/logout destroys the session', async () => {
  const config = testConfig();
  const client = setupMockChurchTools(config.churchtools.baseUrl);
  client.intercept({ path: '/oauth/access_token', method: 'POST' }).reply(200, { access_token: 'tok' });
  client
    .intercept({ path: '/oauth/userinfo', method: 'GET' })
    .reply(200, { id: 9, firstName: 'Log', lastName: 'Out', email: 'logout@example.org' });
  client.intercept({ path: '/api/groups/10/members', method: 'GET' }).reply(200, { data: [{ personId: 9 }] });
  client.intercept({ path: '/api/groups/20/members', method: 'GET' }).reply(200, { data: [] });

  const db = openDatabase(':memory:');
  const app = createApp({ db, config });
  const agent = request.agent(app);
  const loginRes = await agent.get('/auth/login');
  const state = new URL(loginRes.headers.location).searchParams.get('state');
  await agent.get('/auth/callback').query({ code: 'the-code', state });

  const csrfToken = await fetchCsrfToken(agent, '/pool');
  const res = await agent.post('/auth/logout').type('form').send({ _csrf: csrfToken });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/auth/abgemeldet');

  const poolRes = await agent.get('/pool');
  assert.equal(poolRes.status, 401, 'the session must actually be gone, not just redirected away from');
  db.close();
});

test('GET /auth/abgemeldet renders a confirmation page instead of bouncing straight back into ChurchTools SSO login', async () => {
  // Regression guard for the "Abmelden funktioniert nicht" bug: redirecting straight to '/' after
  // logout used to auto-trigger /auth/login -> ChurchTools authorize -> silent re-approval whenever
  // the ChurchTools-side session was still active, so the button looked like it did nothing. This
  // page must actually render (not redirect onward) and must not claim anyone is still logged in.
  const config = testConfig();
  const db = openDatabase(':memory:');
  const app = createApp({ db, config });
  const res = await request(app).get('/auth/abgemeldet');
  assert.equal(res.status, 200);
  assert.match(res.text, /abgemeldet/i);
  assert.doesNotMatch(res.text, /Angemeldet als/);
  // Confirmed against the live instance (life-church.church.tools) by the user: ChurchTools'
  // own logout is a query-param route on the base URL, not a /logout path.
  assert.match(res.text, /https:\/\/ct\.example\.org\/\?q=logout/);
  db.close();
});

// --- Anmeldungen und Warnung bei neuem Gerät ---
function stubMailer({ fail = false } = {}) {
  const sent = [];
  return {
    sent,
    async sendMail(mail) {
      if (fail) throw new Error('SMTP nicht erreichbar');
      sent.push(mail);
    },
  };
}

async function anmelden(agent, config) {
  const client = setupMockChurchTools(config.churchtools.baseUrl);
  client.intercept({ path: '/oauth/access_token', method: 'POST' }).reply(200, { access_token: 'tok' });
  client.intercept({ path: '/oauth/userinfo', method: 'GET' }).reply(200, { id: 7, firstName: 'Max', lastName: 'Muster', email: 'max@example.org' });
  client.intercept({ path: '/api/groups/10/members', method: 'GET' }).reply(200, { data: [{ personId: 7 }] });
  client.intercept({ path: '/api/groups/20/members', method: 'GET' }).reply(200, { data: [] });
  const loginRes = await agent.get('/auth/login');
  const state = new URL(loginRes.headers.location).searchParams.get('state');
  return agent.get('/auth/callback').query({ code: 'the-code', state });
}

const anmeldungen = (db) => db.prepare('SELECT * FROM nutzung_anmeldungen ORDER BY id').all();

test('erste Anmeldung ohne Mail', async () => {
  const config = testConfig();
  const db = openDatabase(':memory:');
  seedDefaults(db);
  const mailer = stubMailer();
  const agent = request.agent(createApp({ db, config, mailer }));
  const res = await anmelden(agent, config);
  assert.equal(res.status, 302);
  assert.equal(mailer.sent.length, 0);
  const zeilen = anmeldungen(db);
  assert.equal(zeilen.length, 1);
  assert.equal(zeilen[0].erfolg, 1);
  assert.equal(zeilen[0].person_id, '7');
  assert.equal(zeilen[0].neues_geraet, 0);
  assert.match(zeilen[0].geraet_id, /^[0-9a-f]{32}$/);
  db.close();
});

test('zweite Anmeldung vom selben Gerät ohne Mail', async () => {
  const config = testConfig();
  const db = openDatabase(':memory:');
  seedDefaults(db);
  const mailer = stubMailer();
  const agent = request.agent(createApp({ db, config, mailer }));
  await anmelden(agent, config);
  await anmelden(agent, config);
  assert.equal(mailer.sent.length, 0);
  const zeilen = anmeldungen(db);
  assert.equal(zeilen.length, 2);
  assert.equal(zeilen[1].neues_geraet, 0);
  assert.equal(zeilen[0].geraet_id, zeilen[1].geraet_id);
  db.close();
});

test('Anmeldung ohne Cookie → neues Gerät, Mail mit Hinweis', async () => {
  const config = testConfig();
  const db = openDatabase(':memory:');
  seedDefaults(db);
  const mailer = stubMailer();
  const app = createApp({ db, config, mailer });
  await anmelden(request.agent(app), config);
  const res = await anmelden(request.agent(app), config);
  assert.equal(res.status, 302);
  // Versand im Hintergrund.
  await warteBis(() => mailer.sent.length > 0);
  assert.equal(mailer.sent.length, 1);
  assert.equal(mailer.sent[0].to, 'max@example.org');
  assert.match(mailer.sent[0].text, /Wenn du deine Browserdaten gelöscht oder ein privates Fenster benutzt hast, kann auch das der Grund sein\./);
  assert.match(mailer.sent[0].text, /die Portal-Administration/);
  assert.match(mailer.sent[0].text, /\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}/);
  assert.equal(anmeldungen(db)[1].neues_geraet, 1);
  db.close();
});

test('fehlgeschlagener Callback wird erfasst', async () => {
  const config = testConfig();
  const db = openDatabase(':memory:');
  seedDefaults(db);
  const agent = request.agent(createApp({ db, config, mailer: stubMailer() }));
  await agent.get('/auth/login');
  await agent.get('/auth/callback').query({ code: 'x', state: 'falsch' });
  const client = setupMockChurchTools(config.churchtools.baseUrl);
  client.intercept({ path: '/oauth/access_token', method: 'POST' }).reply(400, { error: 'invalid_grant' });
  const loginRes = await agent.get('/auth/login');
  const state = new URL(loginRes.headers.location).searchParams.get('state');
  await agent.get('/auth/callback').query({ code: 'x', state });
  const zeilen = anmeldungen(db);
  assert.deepEqual(zeilen.map((z) => [z.erfolg, z.grund, z.person_id]), [[0, 'state_ungueltig', null], [0, 'token_fehler', null]]);
  db.close();
});

test('Mail-Fehler bricht Login nicht ab', async () => {
  const config = testConfig();
  const db = openDatabase(':memory:');
  seedDefaults(db);
  const app = createApp({ db, config, mailer: stubMailer({ fail: true }) });
  await anmelden(request.agent(app), config);
  const res = await anmelden(request.agent(app), config);
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/pool');
  assert.equal(anmeldungen(db)[1].neues_geraet, 1);
  await warteBis(() => db.prepare("SELECT versuche FROM mail_log WHERE typ = 'neues-geraet'").get()?.versuche >= 1);
  db.close();
});

test('Anmeldung wartet nicht auf einen hängenden Mailserver', async () => {
  const config = testConfig();
  const db = openDatabase(':memory:');
  seedDefaults(db);
  let freigeben;
  const haengend = new Promise((resolve) => { freigeben = resolve; });
  const app = createApp({ db, config, mailer: { sendMail: () => haengend } });
  await anmelden(request.agent(app), config);
  const res = await anmelden(request.agent(app), config);
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/pool');
  assert.equal(db.prepare("SELECT status FROM mail_log WHERE typ = 'neues-geraet'").get().status, 'eingereiht');
  freigeben();
  await warteBis(() => db.prepare("SELECT status FROM mail_log WHERE typ = 'neues-geraet'").get().status === 'versendet');
  db.close();
});
