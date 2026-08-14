import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { openDatabase } from '../../src/db/index.js';
import { createApp } from '../../src/app.js';

function testConfig() {
  return {
    sessionSecret: 'test-secret',
    env: 'test',
    churchtools: {
      baseUrl: 'https://ct.example.org',
      groupIdBuchhaltung: '10',
      groupIdAdmin: '20',
    },
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
  db.close();
});
