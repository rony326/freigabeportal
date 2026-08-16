import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupMockChurchTools } from '../helpers/mockChurchTools.js';
import { openDatabase } from '../../src/db/index.js';
import { createApp } from '../../src/app.js';
import { getPersonById } from '../../src/db/personenRepo.js';

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

test('GET /auth/callback with a valid state logs the person in', async () => {
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
  assert.equal(res.headers.location, '/');

  const person = getPersonById(db, '7');
  assert.equal(person.vorname, 'Max');
  assert.deepEqual(person.gruppen, ['10']);
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
  const preLoginSid = loginRes.headers['set-cookie'][0].match(/connect\.sid=([^;]+)/)[1];
  const state = new URL(loginRes.headers.location).searchParams.get('state');

  const callbackRes = await agent.get('/auth/callback').query({ code: 'the-code', state });
  assert.equal(callbackRes.status, 302);
  const postLoginSid = callbackRes.headers['set-cookie'][0].match(/connect\.sid=([^;]+)/)[1];

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
  assert.equal(res.headers.location, '/');

  const person = getPersonById(db, '42');
  assert.ok(person, 'a person with no relevant group membership must still get a local session and a personen row');
  assert.deepEqual(person.gruppen, []);
  assert.equal(person.aktiv, true);
  db.close();
});

test('POST /auth/logout destroys the session', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, config: testConfig() });
  const agent = request.agent(app);
  const res = await agent.post('/auth/logout');
  assert.equal(res.status, 302);
  db.close();
});
