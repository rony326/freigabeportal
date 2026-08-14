import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
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

test('a thrown error in a route is caught and rendered as a German 500 page', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, config: testConfig() });
  app.get('/__boom', () => {
    throw new Error('kaboom');
  });
  const res = await request(app).get('/__boom');
  assert.equal(res.status, 500);
  assert.match(res.text, /unerwarteter Fehler/);
  db.close();
});
