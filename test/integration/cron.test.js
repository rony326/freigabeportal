import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupMockChurchTools } from '../helpers/mockChurchTools.js';
import { openDatabase } from '../../src/db/index.js';
import { createApp } from '../../src/app.js';
import { startSyncLog } from '../../src/db/syncLogRepo.js';

function testConfig() {
  return {
    sessionSecret: 'test-secret',
    env: 'test',
    cronSecret: 'cron-secret',
    churchtools: {
      baseUrl: 'https://ct.example.org',
      groupIdBuchhaltung: '10',
      groupIdAdmin: '20',
      syncServiceToken: 'service-token',
    },
  };
}

test('POST /internal/cron/sync-personen without the secret is rejected', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, config: testConfig() });
  const res = await request(app).post('/internal/cron/sync-personen');
  assert.equal(res.status, 401);
  db.close();
});

test('POST /internal/cron/sync-personen runs the sync with the correct secret', async () => {
  const config = testConfig();
  const client = setupMockChurchTools(config.churchtools.baseUrl);
  client.intercept({ path: '/api/groups/10/members', method: 'GET' }).reply(200, { data: [] });
  client.intercept({ path: '/api/groups/20/members', method: 'GET' }).reply(200, { data: [] });

  const db = openDatabase(':memory:');
  const app = createApp({ db, config });
  const res = await request(app).post('/internal/cron/sync-personen').set('X-Cron-Secret', 'cron-secret');

  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'erfolg');
  db.close();
});

test('POST /internal/cron/sync-personen returns 409 while a run is already active', async () => {
  const config = testConfig();
  const db = openDatabase(':memory:');
  startSyncLog(db);
  const app = createApp({ db, config });
  const res = await request(app).post('/internal/cron/sync-personen').set('X-Cron-Secret', 'cron-secret');
  assert.equal(res.status, 409);
  db.close();
});
