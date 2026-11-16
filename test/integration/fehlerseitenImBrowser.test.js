// U4 (Prüfung 2026-11-15): 429 und /downloads/:id/oeffnen zeigen im Browser die Fehlerseite, für fetch bleibt JSON.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupMockChurchTools } from '../helpers/mockChurchTools.js';
import { openDatabase } from '../../src/db/index.js';
import { createApp } from '../../src/app.js';
import { createPublicRateLimiter, createSessionRateLimiter, createMachineRateLimiter } from '../../src/middleware/rateLimit.js';

const HTML = 'text/html,application/xhtml+xml';

function testConfig() {
  return {
    sessionSecret: 'test-secret', env: 'test', publicBaseUrl: 'http://portal.example.org',
    churchtools: { baseUrl: 'https://ct.example.org', clientId: 'c', clientSecret: 's', redirectUri: 'https://portal.example.org/auth/callback', groupIdBuchhaltung: '10', groupIdAdmin: '20' },
    n8nApiKey: 'k', cronSecret: 'cron', downloadSigningSecret: 'x', jobsDir: '/tmp/freigabeportal-rueckkehr-test-jobs',
  };
}

function mockLogin(config) {
  const client = setupMockChurchTools(config.churchtools.baseUrl);
  client.intercept({ path: '/oauth/access_token', method: 'POST' }).reply(200, { access_token: 'tok' });
  client.intercept({ path: '/oauth/userinfo', method: 'GET' }).reply(200, { id: 1, firstName: 'Buch', lastName: 'Halter', email: 'b@example.org' });
  client.intercept({ path: '/api/groups/10/members', method: 'GET' }).reply(200, { data: [{ personId: 1 }] });
  client.intercept({ path: '/api/groups/20/members', method: 'GET' }).reply(200, { data: [] });
}

// Führt /auth/login + /auth/callback aus und liefert die Callback-Antwort.
async function anmelden(agent, config) {
  mockLogin(config);
  const r = await agent.get('/auth/login');
  const state = new URL(r.headers.location).searchParams.get('state');
  return agent.get('/auth/callback').query({ code: 'c', state });
}

function neu() {
  const db = openDatabase(':memory:');
  const config = testConfig();
  return { db, config, agent: request.agent(createApp({ db, config })) };
}

test('U4: 429 im Browser zeigt die Fehlerseite mit Wartezeit, Retry-After bleibt; fetch bekommt JSON', async () => {
  const db = openDatabase(':memory:');
  const limiter = { publicLimiter: createPublicRateLimiter({ limit: 1, windowMs: 5 * 60 * 1000 }), sessionLimiter: createSessionRateLimiter(), machineLimiter: createMachineRateLimiter() };
  const app = createApp({ db, config: testConfig(), limiter });
  await request(app).get('/');
  const html = await request(app).get('/').set('Accept', HTML);
  assert.equal(html.status, 429);
  assert.match(html.headers['content-type'], /text\/html/);
  assert.match(html.text, /in etwa \d+ Minuten?/);
  assert.match(html.text, /Zu viele Anfragen/);
  assert.ok(Number(html.headers['retry-after']) > 0);
  const json = await request(app).get('/').set('Accept', 'application/json');
  assert.equal(json.status, 429);
  assert.deepEqual(json.body, { error: 'Zu viele Anfragen, bitte später erneut versuchen.' });
  assert.ok(json.headers['retry-after']);
  db.close();
});

test('U4: Fehler von /downloads/:id/oeffnen erscheinen im Browser als Fehlerseite, für fetch als JSON', async () => {
  const { db, config, agent } = neu();
  await anmelden(agent, config);
  const html = await agent.get('/downloads/999/oeffnen').set('Accept', HTML);
  assert.equal(html.status, 404);
  assert.match(html.headers['content-type'], /text\/html/);
  assert.match(html.text, /Job nicht gefunden/);
  const json = await agent.get('/downloads/999/oeffnen').set('Accept', 'application/json');
  assert.equal(json.status, 404);
  assert.deepEqual(json.body, { error: 'Job nicht gefunden.' });
  db.close();
});
