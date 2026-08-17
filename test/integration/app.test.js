import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupMockChurchTools } from '../helpers/mockChurchTools.js';
import { openDatabase } from '../../src/db/index.js';
import { createApp } from '../../src/app.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createKonto } from '../../src/db/kontenRepo.js';
import { createJob, claimJob } from '../../src/db/jobsRepo.js';
import { setConfigValue } from '../../src/db/adminConfigRepo.js';

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

test('GET /vendor/bootstrap/bootstrap.min.css is served as a static asset', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, config: testConfig() });
  const res = await request(app).get('/vendor/bootstrap/bootstrap.min.css');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /css/);
  db.close();
});

test('GET /vendor/bootstrap/bootstrap.bundle.min.js is served as a static asset', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, config: testConfig() });
  const res = await request(app).get('/vendor/bootstrap/bootstrap.bundle.min.js');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /javascript/);
  db.close();
});

test('every top-level view carries a viewport meta tag', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, config: testConfig() });
  const homeRes = await request(app).get('/');
  assert.match(homeRes.text, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  const errorRes = await request(app).get('/nonexistent-route-xyz');
  assert.match(errorRes.text, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
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

test('GET / renders the logo in the centered header cell when logoAusrichtung is "mitte"', async () => {
  const db = openDatabase(':memory:');
  setConfigValue(db, 'branding_logo_pfad', '/data/branding/logo.png');
  setConfigValue(db, 'branding_logo_mimetype', 'image/png');
  setConfigValue(db, 'branding_logo_ausrichtung', 'mitte');
  const app = createApp({ db, config: testConfig() });
  const res = await request(app).get('/');
  assert.equal(res.status, 200);
  assert.match(res.text, /<div class="text-center">\s*<img src="\/branding\/logo" alt="Logo" height="48" class="mt-2 mx-2">/);
  assert.doesNotMatch(res.text, /<div class="text-start">\s*<img/, 'the left cell should stay empty when alignment is "mitte"');
  db.close();
});

test('GET / renders the logo in the right header cell alongside the theme toggle when logoAusrichtung is "rechts"', async () => {
  const db = openDatabase(':memory:');
  setConfigValue(db, 'branding_logo_pfad', '/data/branding/logo.png');
  setConfigValue(db, 'branding_logo_mimetype', 'image/png');
  setConfigValue(db, 'branding_logo_ausrichtung', 'rechts');
  const app = createApp({ db, config: testConfig() });
  const res = await request(app).get('/');
  assert.equal(res.status, 200);
  assert.match(res.text, /<img src="\/branding\/logo" alt="Logo" height="48" class="mt-2 mx-2">\s*<button type="button" id="theme-toggle"/);
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
    .intercept({ path: '/oauth/userinfo', method: 'GET' })
    .reply(200, { id: 1, firstName: 'Buch', lastName: 'Halter', email: 'buch@example.org' });
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

test('Hauptmenü shows only the Aufgaben entry for a Buchhaltung-only member, active on /pool', async () => {
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
    .intercept({ path: '/oauth/userinfo', method: 'GET' })
    .reply(200, { id: 1, firstName: 'Buch', lastName: 'Halter', email: 'buch@example.org' });
  client.intercept({ path: '/api/groups/10/members', method: 'GET' }).reply(200, { data: [{ personId: 1 }] });
  client.intercept({ path: '/api/groups/20/members', method: 'GET' }).reply(200, { data: [] });

  const db = openDatabase(':memory:');
  const app = createApp({ db, config });
  const agent = request.agent(app);
  const loginRes = await agent.get('/auth/login');
  const state = new URL(loginRes.headers.location).searchParams.get('state');
  await agent.get('/auth/callback').query({ code: 'the-code', state });

  const res = await agent.get('/pool');
  assert.match(res.text, /class="dropdown-item active" href="\/pool"/);
  assert.doesNotMatch(res.text, /href="\/admin"/);
  db.close();
});

test('Hauptmenü shows both Aufgaben and Admin entries for a Portal-Admin, Admin active on /admin', async () => {
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
    .intercept({ path: '/oauth/userinfo', method: 'GET' })
    .reply(200, { id: 2, firstName: 'Admin', lastName: 'Only', email: 'admin@example.org' });
  client.intercept({ path: '/api/groups/10/members', method: 'GET' }).reply(200, { data: [] });
  client.intercept({ path: '/api/groups/20/members', method: 'GET' }).reply(200, { data: [{ personId: 2 }] });

  const db = openDatabase(':memory:');
  const app = createApp({ db, config });
  const agent = request.agent(app);
  const loginRes = await agent.get('/auth/login');
  const state = new URL(loginRes.headers.location).searchParams.get('state');
  await agent.get('/auth/callback').query({ code: 'the-code', state });

  const res = await agent.get('/admin');
  assert.match(res.text, /href="\/pool">Aufgaben/);
  assert.match(res.text, /class="dropdown-item active" href="\/admin">Admin/);
  db.close();
});

test('Hauptmenü renders no menu at all for an anonymous visitor', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, config: testConfig() });
  const res = await request(app).get('/');
  assert.doesNotMatch(res.text, /dropdown-menu/);
  assert.doesNotMatch(res.text, />Aufgaben</);
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
    .intercept({ path: '/oauth/userinfo', method: 'GET' })
    .reply(200, { id: 1, firstName: 'Buch', lastName: 'Halter', email: 'buch@example.org' });
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

test('GET / shows a link to /pool for a logged-in Portal-Admin who is not also in Buchhaltung (nav-tabs mirrors /pool\'s requireAnyRole gate)', async () => {
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
    .intercept({ path: '/oauth/userinfo', method: 'GET' })
    .reply(200, { id: 2, firstName: 'Admin', lastName: 'Only', email: 'admin@example.org' });
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
  assert.match(res.text, /href="\/pool"/);
  db.close();
});

test('GET / shows no /pool or /admin link for a logged-in person in neither Buchhaltung nor Portal-Admin', async () => {
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
    .intercept({ path: '/oauth/userinfo', method: 'GET' })
    .reply(200, { id: 30, firstName: 'Ohne', lastName: 'Gruppe', email: 'ohne@example.org' });
  client.intercept({ path: '/api/groups/10/members', method: 'GET' }).reply(200, { data: [] });
  client.intercept({ path: '/api/groups/20/members', method: 'GET' }).reply(200, { data: [] });

  const db = openDatabase(':memory:');
  const app = createApp({ db, config });
  const agent = request.agent(app);
  const loginRes = await agent.get('/auth/login');
  const state = new URL(loginRes.headers.location).searchParams.get('state');
  await agent.get('/auth/callback').query({ code: 'the-code', state });

  const res = await agent.get('/');
  assert.equal(res.status, 200);
  assert.doesNotMatch(res.text, /href="\/pool"/);
  assert.doesNotMatch(res.text, /href="\/admin"/);
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
    .intercept({ path: '/oauth/userinfo', method: 'GET' })
    .reply(200, { id: 2, firstName: 'Admin', lastName: 'Only', email: 'admin@example.org' });
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

test('GET /admin renders a dashboard with links to all eight admin areas for a Portal-Admin', async () => {
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
    .intercept({ path: '/oauth/userinfo', method: 'GET' })
    .reply(200, { id: 2, firstName: 'Admin', lastName: 'Only', email: 'admin@example.org' });
  client.intercept({ path: '/api/groups/10/members', method: 'GET' }).reply(200, { data: [] });
  client.intercept({ path: '/api/groups/20/members', method: 'GET' }).reply(200, { data: [{ personId: 2 }] });

  const db = openDatabase(':memory:');
  const app = createApp({ db, config });
  const agent = request.agent(app);
  const loginRes = await agent.get('/auth/login');
  const state = new URL(loginRes.headers.location).searchParams.get('state');
  await agent.get('/auth/callback').query({ code: 'the-code', state });

  const res = await agent.get('/admin');
  assert.equal(res.status, 200);
  for (const path of ['/admin/konten', '/admin/zuweisungsregeln', '/admin/eskalation', '/admin/erscheinungsbild', '/admin/personen', '/admin/pdf-einstellungen', '/admin/mails', '/admin/sync']) {
    assert.match(res.text, new RegExp(`href="${path}"`), `expected a link to ${path}`);
  }
  db.close();
});

test('GET /admin returns 403 for a logged-in Buchhaltung-only member', async () => {
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
    .intercept({ path: '/oauth/userinfo', method: 'GET' })
    .reply(200, { id: 1, firstName: 'Buch', lastName: 'Halter', email: 'buch@example.org' });
  client.intercept({ path: '/api/groups/10/members', method: 'GET' }).reply(200, { data: [{ personId: 1 }] });
  client.intercept({ path: '/api/groups/20/members', method: 'GET' }).reply(200, { data: [] });

  const db = openDatabase(':memory:');
  const app = createApp({ db, config });
  const agent = request.agent(app);
  const loginRes = await agent.get('/auth/login');
  const state = new URL(loginRes.headers.location).searchParams.get('state');
  await agent.get('/auth/callback').query({ code: 'the-code', state });

  const res = await agent.get('/admin');
  assert.equal(res.status, 403);
  db.close();
});

test('GET /admin returns 401 for an anonymous visitor', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, config: testConfig() });
  const res = await request(app).get('/admin');
  assert.equal(res.status, 401);
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
    .intercept({ path: '/oauth/userinfo', method: 'GET' })
    .reply(200, { id: 5, firstName: 'Frei', lastName: 'Geber', email: 'frei@example.org' });
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
  // The Zurück button must show on /kontierung even for a person with no Buchhaltung/Portal-Admin
  // group membership (no Menü dropdown for them at all) — it's gated on the current path, not on role.
  assert.match(res.text, /<a href="\/pool" class="btn btn-primary btn-sm">← Zurück<\/a>/);
  db.close();
});

test('on /kontierung, the Zurück button renders to the right of the Menü dropdown', async () => {
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
    .intercept({ path: '/oauth/userinfo', method: 'GET' })
    .reply(200, { id: 1, firstName: 'Buch', lastName: 'Halter', email: 'buch@example.org' });
  client.intercept({ path: '/api/groups/10/members', method: 'GET' }).reply(200, { data: [{ personId: 1 }] });
  client.intercept({ path: '/api/groups/20/members', method: 'GET' }).reply(200, { data: [] });

  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'Buch', nachname: 'Halter', email: 'buch@example.org', gruppen: ['10'], loggedInNow: false });
  for (const id of ['2', '3']) {
    upsertPerson(db, { id, vorname: `Person${id}`, nachname: 'Muster', email: `p${id}@example.org`, gruppen: [], loggedInNow: false });
  }
  createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '2' });
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, jobId, '1');

  const app = createApp({ db, config });
  const agent = request.agent(app);
  const loginRes = await agent.get('/auth/login');
  const state = new URL(loginRes.headers.location).searchParams.get('state');
  await agent.get('/auth/callback').query({ code: 'the-code', state });

  const res = await agent.get(`/kontierung/${jobId}`);
  assert.equal(res.status, 200);
  const menuIndex = res.text.indexOf('hauptmenue-toggle');
  const zurueckIndex = res.text.indexOf('← Zurück');
  assert.ok(menuIndex >= 0 && zurueckIndex >= 0, 'both the Menü dropdown and the Zurück button should be present');
  assert.ok(menuIndex < zurueckIndex, 'Menü dropdown should render before (to the left of) the Zurück button');
  db.close();
});

test('the Zurück button does not appear on /pool itself', async () => {
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
    .intercept({ path: '/oauth/userinfo', method: 'GET' })
    .reply(200, { id: 1, firstName: 'Buch', lastName: 'Halter', email: 'buch@example.org' });
  client.intercept({ path: '/api/groups/10/members', method: 'GET' }).reply(200, { data: [{ personId: 1 }] });
  client.intercept({ path: '/api/groups/20/members', method: 'GET' }).reply(200, { data: [] });

  const db = openDatabase(':memory:');
  const app = createApp({ db, config });
  const agent = request.agent(app);
  const loginRes = await agent.get('/auth/login');
  const state = new URL(loginRes.headers.location).searchParams.get('state');
  await agent.get('/auth/callback').query({ code: 'the-code', state });

  const res = await agent.get('/pool');
  assert.doesNotMatch(res.text, /← Zurück/);
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
    .intercept({ path: '/oauth/userinfo', method: 'GET' })
    .reply(200, { id: 42, firstName: 'Ohne', lastName: 'Gruppe', email: 'ohne@example.org' });
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
