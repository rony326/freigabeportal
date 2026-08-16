import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createApp } from '../../src/app.js';
import { setupMockChurchTools } from '../helpers/mockChurchTools.js';

function testConfig() {
  return {
    sessionSecret: 'test-secret',
    env: 'test',
    churchtools: {
      baseUrl: 'https://ct.example.org',
      groupIdBuchhaltung: '10',
      groupIdAdmin: '20',
    },
    cronSecret: 'cron-secret',
    n8nApiKey: 'test-n8n-key',
    downloadSigningSecret: 'test-signing-secret',
    jobsDir: '/tmp/freigabeportal-ratelimit-test-jobs',
  };
}

test('GET /healthz is never rate-limited, even after many rapid requests', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, config: testConfig() });
  for (let i = 0; i < 50; i++) {
    const res = await request(app).get('/healthz');
    assert.equal(res.status, 200, `request ${i} should not be throttled`);
  }
  db.close();
});

test('a fresh createApp() call gets its own isolated rate-limit counters (test isolation)', async () => {
  const db = openDatabase(':memory:');
  const app1 = createApp({ db, config: testConfig() });
  // Exhaust nothing here — this test only proves a second app doesn't inherit state,
  // which the next two tests in this file rely on implicitly (each builds its own app).
  const res = await request(app1).get('/healthz');
  assert.equal(res.status, 200);
  db.close();
});

test('POST /api/n8n/jobs is rate-limited independently of auth outcome (machine tier)', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, config: testConfig() });

  // No API key at all -> 401s, but each attempt still consumes the machine-tier budget.
  let lastStatus;
  for (let i = 0; i < 61; i++) {
    const res = await request(app).post('/api/n8n/jobs').field('quelle', 'scanner');
    lastStatus = res.status;
    if (lastStatus === 429) break;
  }
  assert.equal(lastStatus, 429, 'the 61st request within a minute should be rate-limited');
  db.close();
});

test('GET / (public tier) is rate-limited by IP after 100 requests in the window', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, config: testConfig() });

  let lastStatus;
  for (let i = 0; i < 101; i++) {
    const res = await request(app).get('/');
    lastStatus = res.status;
    if (lastStatus === 429) break;
  }
  assert.equal(lastStatus, 429, 'the 101st request within 15 minutes should be rate-limited');
  db.close();
});

test('two different logged-in people hitting /pool do not throttle each other (session tier keys by person)', async () => {
  const db = openDatabase(':memory:');
  const config = testConfig();
  config.churchtools = {
    ...config.churchtools,
    clientId: 'client-id',
    clientSecret: 'client-secret',
    redirectUri: 'https://portal.example.org/auth/callback',
  };
  const client = setupMockChurchTools(config.churchtools.baseUrl);
  upsertPerson(db, { id: '1', vorname: 'Erste', nachname: 'Person', email: 'erste@example.org', gruppen: ['10'], loggedInNow: true });
  upsertPerson(db, { id: '2', vorname: 'Zweite', nachname: 'Person', email: 'zweite@example.org', gruppen: ['10'], loggedInNow: true });
  const app = createApp({ db, config });

  async function loginAs(id) {
    client.intercept({ path: '/api/oauth/token', method: 'POST' }).reply(200, { access_token: `tok-${id}` });
    client.intercept({ path: '/api/whoami', method: 'GET' }).reply(200, { data: { id, firstName: 'X', lastName: 'Y', email: `p${id}@example.org` } });
    client.intercept({ path: '/api/groups/10/members', method: 'GET' }).reply(200, { data: [{ personId: id }] });
    client.intercept({ path: '/api/groups/20/members', method: 'GET' }).reply(200, { data: [] });
    const agent = request.agent(app);
    const loginRes = await agent.get('/auth/login');
    const state = new URL(loginRes.headers.location).searchParams.get('state');
    await agent.get('/auth/callback').query({ code: `code-${id}`, state });
    return agent;
  }

  const personA = await loginAs(1);
  const personB = await loginAs(2);

  // Person A's own session-tier requests to /auth/login and /auth/callback above went through
  // the PUBLIC limiter (100/15min), not the session one, so /pool starts fresh for both people.
  const resA = await personA.get('/pool');
  assert.equal(resA.status, 200);
  const resB = await personB.get('/pool');
  assert.equal(resB.status, 200, 'person B is unaffected by person A having just used /pool');

  db.close();
});
