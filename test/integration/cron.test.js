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

function createStubMailer() {
  const sent = [];
  return { sent, async sendMail(mail) { sent.push(mail); } };
}

test('POST /internal/cron/pool-erinnerungen without the secret is rejected', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, config: testConfig() });
  const res = await request(app).post('/internal/cron/pool-erinnerungen');
  assert.equal(res.status, 401);
  db.close();
});

test('POST /internal/cron/pool-erinnerungen sends one reminder mail per stale pool job and marks it sent, is idempotent on a second run', async () => {
  const { seedDefaults } = await import('../../src/db/adminConfigRepo.js');
  const { createJob, getJobById } = await import('../../src/db/jobsRepo.js');
  const { listMailLog } = await import('../../src/db/mailLogRepo.js');
  const db = openDatabase(':memory:');
  seedDefaults(db);
  const jobId = createJob(db, { eingangAm: '2020-01-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'alt.pdf', pdfPfad: '/tmp/a.pdf' });
  const { upsertPerson } = await import('../../src/db/personenRepo.js');
  upsertPerson(db, { id: '1', vorname: 'Buch', nachname: 'Halter', email: 'buch@example.org', gruppen: ['10'], loggedInNow: false });

  const config = { ...testConfig(), publicBaseUrl: 'https://portal.example.org' };
  const client = setupMockChurchTools(config.churchtools.baseUrl);
  const app = createApp({ db, config });

  const res1 = await request(app).post('/internal/cron/pool-erinnerungen').set('X-Cron-Secret', 'cron-secret');
  assert.equal(res1.status, 200);
  assert.equal(res1.body.reminder, 1);
  assert.equal(getJobById(db, jobId).reminder_gesendet_at !== null, true);
  assert.equal(listMailLog(db).filter((m) => m.typ === 'reminder').length, 1);

  const res2 = await request(app).post('/internal/cron/pool-erinnerungen').set('X-Cron-Secret', 'cron-secret');
  assert.equal(res2.status, 200);
  assert.equal(res2.body.reminder, 0, 'the same job must not be reminded twice');
  assert.equal(listMailLog(db).filter((m) => m.typ === 'reminder').length, 1);
  db.close();
});

test('POST /internal/cron/pool-erinnerungen sends escalation mail independently of reminder, both can fire for the same very-stale job', async () => {
  const { seedDefaults } = await import('../../src/db/adminConfigRepo.js');
  const { createJob } = await import('../../src/db/jobsRepo.js');
  const { listMailLog } = await import('../../src/db/mailLogRepo.js');
  const { upsertPerson } = await import('../../src/db/personenRepo.js');
  const db = openDatabase(':memory:');
  seedDefaults(db);
  createJob(db, { eingangAm: '2020-01-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'alt.pdf', pdfPfad: '/tmp/a.pdf' });
  upsertPerson(db, { id: '1', vorname: 'Buch', nachname: 'Halter', email: 'buch@example.org', gruppen: ['10'], loggedInNow: false });

  const config = { ...testConfig(), publicBaseUrl: 'https://portal.example.org' };
  const app = createApp({ db, config });

  const res = await request(app).post('/internal/cron/pool-erinnerungen').set('X-Cron-Secret', 'cron-secret');
  assert.equal(res.status, 200);
  assert.equal(res.body.reminder, 1);
  assert.equal(res.body.eskalation, 1);
  assert.equal(listMailLog(db).filter((m) => m.typ === 'reminder').length, 1);
  assert.equal(listMailLog(db).filter((m) => m.typ === 'eskalation').length, 1);
  db.close();
});
