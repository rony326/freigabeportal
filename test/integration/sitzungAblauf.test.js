// U2 (Prüfung 2026-11-15): Ablauf-Hinweis der Sitzung und klare Meldung bei abgelaufener Anmeldung.
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

test('U2: eingeloggte Seiten tragen den festen Ablaufzeitpunkt (8 Stunden ab Login), Aktivität verlängert ihn nicht', async () => {
  const { db, config, agent } = neu();
  const vorLogin = Date.now();
  await anmelden(agent, config);
  const a = (await agent.get('/pool')).text;
  const m = a.match(/id="sitzung-hinweis"[^>]*data-ablauf="([^"]+)"/);
  assert.ok(m, 'Hinweis-Element mit data-ablauf fehlt');
  const ablauf = Date.parse(m[1]);
  assert.ok(ablauf >= vorLogin + 8 * 3600 * 1000 - 1000 && ablauf <= Date.now() + 8 * 3600 * 1000 + 1000);
  assert.match(a, /id="sitzung-hinweis"[^>]*role="status"/);
  assert.match(a, /aria-live="polite"/);
  assert.match(a, /\/js\/sitzungHinweis\.js/);
  await new Promise((r) => setTimeout(r, 1100));
  const b = (await agent.get('/pool')).text;
  assert.equal(b.match(/data-ablauf="([^"]+)"/)[1], m[1], 'der Ablauf darf sich durch Aktivität nicht verschieben');
  db.close();
});

test('U2: anonyme Seiten tragen keinen Ablauf-Hinweis', async () => {
  const { db, agent } = neu();
  const res = await agent.get('/auth/abgemeldet');
  assert.doesNotMatch(res.text, /sitzung-hinweis/);
  db.close();
});

test('U2: die CSRF-Fehlerseite einer abgelaufenen Anmeldung sagt, dass die Anmeldung abgelaufen ist', async () => {
  const { db, config, agent } = neu();
  await anmelden(agent, config);
  db.prepare('DELETE FROM sessions').run(); // Sitzung serverseitig weg = abgelaufen
  const res = await agent.post('/auth/logout').type('form').send({ _csrf: 'alt' }).set('Accept', HTML);
  assert.equal(res.status, 403);
  assert.match(res.text, /Deine Anmeldung ist abgelaufen/);
  assert.match(res.text, /href="\/auth\/login"/);
  db.close();
});
