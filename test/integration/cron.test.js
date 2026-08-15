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

test('POST /internal/cron/pool-erinnerungen does not mark a job sent when resolveEmpfaenger yields zero recipients, so a later sweep can still retry it', async () => {
  const { seedDefaults } = await import('../../src/db/adminConfigRepo.js');
  const { createJob, getJobById } = await import('../../src/db/jobsRepo.js');
  const { listMailLog } = await import('../../src/db/mailLogRepo.js');
  const db = openDatabase(':memory:');
  seedDefaults(db); // reminder_empfaenger/eskalation_empfaenger default to 'gruppe:buchhaltung'
  // Deliberately no persons seeded at all -> the buchhaltung group resolves to zero active
  // members, e.g. the window between first deployment boot and the first sync-personen run.
  const jobId = createJob(db, { eingangAm: '2020-01-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'alt.pdf', pdfPfad: '/tmp/a.pdf' });

  const config = { ...testConfig(), publicBaseUrl: 'https://portal.example.org' };
  const app = createApp({ db, config });

  const res1 = await request(app).post('/internal/cron/pool-erinnerungen').set('X-Cron-Secret', 'cron-secret');
  assert.equal(res1.status, 200);
  assert.equal(res1.body.reminder, 1);
  assert.equal(res1.body.eskalation, 1);
  assert.equal(listMailLog(db).length, 0, 'zero recipients resolved -> no mail attempts at all, nothing to log');
  const jobAfterFirstSweep = getJobById(db, jobId);
  assert.equal(jobAfterFirstSweep.reminder_gesendet_at, null, 'must not be marked sent when nobody was actually notified');
  assert.equal(jobAfterFirstSweep.eskalation_gesendet_at, null, 'must not be marked sent when nobody was actually notified');

  // A second sweep (simulating the next cron tick, still with no recipients configured) must
  // still pick the job up rather than having silently and permanently lost it.
  const res2 = await request(app).post('/internal/cron/pool-erinnerungen').set('X-Cron-Secret', 'cron-secret');
  assert.equal(res2.status, 200);
  assert.equal(res2.body.reminder, 1, 'still eligible for a retry on the next sweep');
  assert.equal(res2.body.eskalation, 1, 'still eligible for a retry on the next sweep');
  db.close();
});

test('POST /internal/cron/pool-erinnerungen returns a JSON error body (not an HTML error page) when the handler throws', async () => {
  const { seedDefaults, setConfigValue } = await import('../../src/db/adminConfigRepo.js');
  const { createJob } = await import('../../src/db/jobsRepo.js');
  const db = openDatabase(':memory:');
  seedDefaults(db);
  // A non-numeric reminder_stunden makes Number(...) yield NaN, which makes
  // listPoolJobsForReminder's `new Date(NaN).toISOString()` throw a RangeError inside the
  // handler's own try block -- a realistic misconfiguration (e.g. a corrupted admin_config row).
  setConfigValue(db, 'reminder_stunden', 'kaputt');
  createJob(db, { eingangAm: '2020-01-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'alt.pdf', pdfPfad: '/tmp/a.pdf' });
  const config = { ...testConfig(), publicBaseUrl: 'https://portal.example.org' };
  const app = createApp({ db, config });

  const res = await request(app).post('/internal/cron/pool-erinnerungen').set('X-Cron-Secret', 'cron-secret');
  assert.equal(res.status, 500);
  assert.equal(res.body.status, 'fehler');
  assert.equal(typeof res.body.error, 'string');
  assert.equal(res.type, 'application/json');
  db.close();
});
