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
