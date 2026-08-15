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
