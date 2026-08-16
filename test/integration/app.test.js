import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupMockChurchTools } from '../helpers/mockChurchTools.js';
import { openDatabase } from '../../src/db/index.js';
import { createApp } from '../../src/app.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createKonto } from '../../src/db/kontenRepo.js';
import { createJob, claimJob } from '../../src/db/jobsRepo.js';

function testConfig() {
  return {
    sessionSecret: 'test-secret',
    env: 'test',
    churchtools: {
      baseUrl: 'https://ct.example.org',
      groupIdBuchhaltung: '10',
      groupIdAdmin: '20',
    },
    n8nApiKey: 'test-n8n-key',
    downloadSigningSecret: 'test-signing-secret',
    jobsDir: '/tmp/freigabeportal-app-test-jobs',
  };
}

test('GET /healthz returns ok', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, config: testConfig() });
  const res = await request(app).get('/healthz');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { status: 'ok' });
  db.close();
});

test('GET / renders the German home page for an anonymous visitor', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, config: testConfig() });
  const res = await request(app).get('/');
  assert.equal(res.status, 200);
  assert.match(res.text, /Nicht angemeldet/);
  assert.doesNotMatch(res.text, /Abmelden/, 'an anonymous visitor should see no logout link');
  db.close();
});

test('GET / shows a logout link for a logged-in person', async () => {
  const config = testConfig();
  config.churchtools = {
    ...config.churchtools,
    clientId: 'client-id',
    clientSecret: 'client-secret',
    redirectUri: 'https://portal.example.org/auth/callback',
  };
  const client = setupMockChurchTools(config.churchtools.baseUrl);
  client.intercept({ path: '/oauth/access_token', method: 'POST' }).reply(200, { access_token: 'tok' });
  client
    .intercept({ path: '/api/whoami', method: 'GET' })
    .reply(200, { data: { id: 1, firstName: 'Buch', lastName: 'Halter', email: 'buch@example.org' } });
  client.intercept({ path: '/api/groups/10/members', method: 'GET' }).reply(200, { data: [{ personId: 1 }] });
  client.intercept({ path: '/api/groups/20/members', method: 'GET' }).reply(200, { data: [] });

  const db = openDatabase(':memory:');
  const app = createApp({ db, config });
  const agent = request.agent(app);
  const loginRes = await agent.get('/auth/login');
  const state = new URL(loginRes.headers.location).searchParams.get('state');
  await agent.get('/auth/callback').query({ code: 'the-code', state });

  const res = await agent.get('/');
  assert.match(res.text, /action="\/auth\/logout"/);
  db.close();
});

test('every response carries the baseline security headers', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, config: testConfig() });
  const res = await request(app).get('/healthz');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  // SAMEORIGIN, not DENY: kontierung.ejs/freigabe2.ejs/pool.ejs all embed the PDF preview in a
  // same-origin <iframe>, and DENY would blank every one of them — this value is load-bearing,
  // not a style preference, do not "harden" it back to DENY.
  assert.equal(res.headers['x-frame-options'], 'SAMEORIGIN');
  assert.equal(res.headers['referrer-policy'], 'no-referrer');
  db.close();
});

test('session cookie is marked Secure when publicBaseUrl is https', async () => {
  const db = openDatabase(':memory:');
  const config = { ...testConfig(), publicBaseUrl: 'https://portal.example.org' };
  const app = createApp({ db, config });
  // express-session refuses to emit Set-Cookie for a `secure: true` cookie unless the request
  // is itself detected as secure — app.js sets `trust proxy: 1`, so X-Forwarded-Proto (exactly
  // what Infomaniak's TLS-terminating reverse proxy sends in production) makes req.secure true.
  const res = await request(app).get('/auth/login').set('X-Forwarded-Proto', 'https');
  const cookie = res.headers['set-cookie'][0];
  assert.match(cookie, /Secure/);
  db.close();
});

test('session cookie is not marked Secure when publicBaseUrl is not https (or is absent)', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, config: testConfig() });
  const res = await request(app).get('/auth/login');
  const cookie = res.headers['set-cookie'][0];
  assert.doesNotMatch(cookie, /Secure/);
  db.close();
});

test('GET / shows a link to /pool for a logged-in buchhaltung member', async () => {
  const config = testConfig();
  config.churchtools = {
    ...config.churchtools,
    clientId: 'client-id',
    clientSecret: 'client-secret',
    redirectUri: 'https://portal.example.org/auth/callback',
  };
  const client = setupMockChurchTools(config.churchtools.baseUrl);
  client.intercept({ path: '/oauth/access_token', method: 'POST' }).reply(200, { access_token: 'tok' });
  client
    .intercept({ path: '/api/whoami', method: 'GET' })
    .reply(200, { data: { id: 1, firstName: 'Buch', lastName: 'Halter', email: 'buch@example.org' } });
  client.intercept({ path: '/api/groups/10/members', method: 'GET' }).reply(200, { data: [{ personId: 1 }] });
  client.intercept({ path: '/api/groups/20/members', method: 'GET' }).reply(200, { data: [] });

  const db = openDatabase(':memory:');
  const app = createApp({ db, config });
  const agent = request.agent(app);
  const loginRes = await agent.get('/auth/login');
  const state = new URL(loginRes.headers.location).searchParams.get('state');
  await agent.get('/auth/callback').query({ code: 'the-code', state });

  const res = await agent.get('/');
  assert.equal(res.status, 200);
  assert.match(res.text, /href="\/pool"/);
  db.close();
});

test('GET / shows no link to /pool for a logged-in person without the buchhaltung group', async () => {
  const config = testConfig();
  config.churchtools = {
    ...config.churchtools,
    clientId: 'client-id',
    clientSecret: 'client-secret',
    redirectUri: 'https://portal.example.org/auth/callback',
  };
  const client = setupMockChurchTools(config.churchtools.baseUrl);
  client.intercept({ path: '/oauth/access_token', method: 'POST' }).reply(200, { access_token: 'tok' });
  client
    .intercept({ path: '/api/whoami', method: 'GET' })
    .reply(200, { data: { id: 2, firstName: 'Admin', lastName: 'Only', email: 'admin@example.org' } });
  client.intercept({ path: '/api/groups/10/members', method: 'GET' }).reply(200, { data: [] });
  client.intercept({ path: '/api/groups/20/members', method: 'GET' }).reply(200, { data: [{ personId: 2 }] });

  const db = openDatabase(':memory:');
  const app = createApp({ db, config });
  const agent = request.agent(app);
  const loginRes = await agent.get('/auth/login');
  const state = new URL(loginRes.headers.location).searchParams.get('state');
  await agent.get('/auth/callback').query({ code: 'the-code', state });

  const res = await agent.get('/');
  assert.equal(res.status, 200);
  assert.match(res.text, /Angemeldet als Admin Only/);
  assert.doesNotMatch(res.text, /href="\/pool"/);
  db.close();
});

test('GET /pool returns 200 for a Portal-Admin who is not also a Buchhaltung member', async () => {
  // SYNC-8: an admin-escalated job's notification email links straight into /kontierung or
  // /freigabe2, and both of those redirect to /pool on successful submission — so /pool itself
  // must not 403 a Portal-Admin, even though the homepage's /pool link is still Buchhaltung-only.
  const config = testConfig();
  config.churchtools = {
    ...config.churchtools,
    clientId: 'client-id',
    clientSecret: 'client-secret',
    redirectUri: 'https://portal.example.org/auth/callback',
  };
  const client = setupMockChurchTools(config.churchtools.baseUrl);
  client.intercept({ path: '/oauth/access_token', method: 'POST' }).reply(200, { access_token: 'tok' });
  client
    .intercept({ path: '/api/whoami', method: 'GET' })
    .reply(200, { data: { id: 2, firstName: 'Admin', lastName: 'Only', email: 'admin@example.org' } });
  client.intercept({ path: '/api/groups/10/members', method: 'GET' }).reply(200, { data: [] });
  client.intercept({ path: '/api/groups/20/members', method: 'GET' }).reply(200, { data: [{ personId: 2 }] });

  const db = openDatabase(':memory:');
  const app = createApp({ db, config });
  const agent = request.agent(app);
  const loginRes = await agent.get('/auth/login');
  const state = new URL(loginRes.headers.location).searchParams.get('state');
  await agent.get('/auth/callback').query({ code: 'the-code', state });

  const res = await agent.get('/pool');
  assert.equal(res.status, 200);
  db.close();
});

test('GET /kontierung/:id is reachable through the real app for the assigned person, even without Buchhaltung or Portal-Admin group membership', async () => {
  const config = testConfig();
  config.churchtools = {
    ...config.churchtools,
    clientId: 'client-id',
    clientSecret: 'client-secret',
    redirectUri: 'https://portal.example.org/auth/callback',
  };
  const client = setupMockChurchTools(config.churchtools.baseUrl);
  client.intercept({ path: '/oauth/access_token', method: 'POST' }).reply(200, { access_token: 'tok' });
  client
    .intercept({ path: '/api/whoami', method: 'GET' })
    .reply(200, { data: { id: 5, firstName: 'Frei', lastName: 'Geber', email: 'frei@example.org' } });
  client.intercept({ path: '/api/groups/10/members', method: 'GET' }).reply(200, { data: [] });
  client.intercept({ path: '/api/groups/20/members', method: 'GET' }).reply(200, { data: [] });

  const db = openDatabase(':memory:');
  for (const id of ['5', '6', '7']) {
    upsertPerson(db, { id, vorname: `Person${id}`, nachname: 'Muster', email: `p${id}@example.org`, gruppen: [], loggedInNow: false });
  }
  createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '5', stellvertreter1Id: '6', freigeber2Id: '7', stellvertreter2Id: '6' });
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, jobId, '5');

  const app = createApp({ db, config });
  const agent = request.agent(app);
  const loginRes = await agent.get('/auth/login');
  const state = new URL(loginRes.headers.location).searchParams.get('state');
  await agent.get('/auth/callback').query({ code: 'the-code', state });

  const res = await agent.get(`/kontierung/${jobId}`);
  assert.equal(res.status, 200);
  db.close();
});

test('a logged-in person with zero relevant ChurchTools groups is still refused by /pool, /api/pool, and /admin/*', async () => {
  // AUTHZ-3/AUTH-WIDEN-1 widened who can even get a session (a session no longer implies
  // Buchhaltung/Portal-Admin membership) — but the group gates on these specific routes must
  // still hold. This is a test-only check; it does not touch app.js's route wiring.
  const config = testConfig();
  config.churchtools = {
    ...config.churchtools,
    clientId: 'client-id',
    clientSecret: 'client-secret',
    redirectUri: 'https://portal.example.org/auth/callback',
  };
  const client = setupMockChurchTools(config.churchtools.baseUrl);
  client.intercept({ path: '/oauth/access_token', method: 'POST' }).reply(200, { access_token: 'tok' });
  client
    .intercept({ path: '/api/whoami', method: 'GET' })
    .reply(200, { data: { id: 42, firstName: 'Ohne', lastName: 'Gruppe', email: 'ohne@example.org' } });
  client.intercept({ path: '/api/groups/10/members', method: 'GET' }).reply(200, { data: [] });
  client.intercept({ path: '/api/groups/20/members', method: 'GET' }).reply(200, { data: [] });

  const db = openDatabase(':memory:');
  const app = createApp({ db, config });
  const agent = request.agent(app);
  const loginRes = await agent.get('/auth/login');
  const state = new URL(loginRes.headers.location).searchParams.get('state');
  await agent.get('/auth/callback').query({ code: 'the-code', state });

  const poolRes = await agent.get('/pool');
  assert.equal(poolRes.status, 403);

  const apiPoolRes = await agent.get('/api/pool');
  assert.equal(apiPoolRes.status, 403);

  const adminRes = await agent.get('/admin/konten');
  assert.equal(adminRes.status, 403);

  db.close();
});

test('Phase C routes are gated exactly as wired in the real app', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, config: testConfig() });

  const poolRes = await request(app).get('/api/pool');
  assert.equal(poolRes.status, 401);

  const abholRes = await request(app).get('/api/n8n/jobs/abholbereit');
  assert.equal(abholRes.status, 401);

  const downloadRes = await request(app).get('/downloads/1');
  assert.equal(downloadRes.status, 403);

  db.close();
});
