import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { seedDefaults, setConfigValue } from '../../src/db/adminConfigRepo.js';
import { msBisNaechstesTaeglichesEreignis, startScheduler } from '../../src/services/scheduler.js';

test('msBisNaechstesTaeglichesEreignis returns the delay until later today when the target has not passed yet (CET, winter)', () => {
  // 2026-01-15T00:30:00Z is 01:30 in Zurich (CET, UTC+1) -- 02:00 is still 30 minutes away.
  const now = new Date('2026-01-15T00:30:00.000Z');
  const ms = msBisNaechstesTaeglichesEreignis(2, 0, now);
  assert.equal(ms, 30 * 60 * 1000);
});

test('msBisNaechstesTaeglichesEreignis rolls over to tomorrow when the target already passed today (CET, winter)', () => {
  // 2026-01-15T10:00:00Z is 11:00 in Zurich (CET, UTC+1) -- 02:00 already passed, next is
  // tomorrow 02:00 local = 2026-01-16T01:00:00Z, 15 hours away.
  const now = new Date('2026-01-15T10:00:00.000Z');
  const ms = msBisNaechstesTaeglichesEreignis(2, 0, now);
  assert.equal(ms, 15 * 60 * 60 * 1000);
});

test('msBisNaechstesTaeglichesEreignis rolls over to tomorrow when now is exactly the target time (CEST, summer)', () => {
  // 2026-07-15T00:00:00Z is exactly 02:00 in Zurich (CEST, UTC+2).
  const now = new Date('2026-07-15T00:00:00.000Z');
  const ms = msBisNaechstesTaeglichesEreignis(2, 0, now);
  assert.equal(ms, 24 * 60 * 60 * 1000);
});

function fakeJobs(overrides = {}) {
  return {
    runSyncPersonenJob: async () => ({ status: 'erfolg' }),
    runPoolErinnerungenJob: async () => ({ status: 'erfolg' }),
    runPdfBereinigungJob: () => ({ status: 'erfolg' }),
    ...overrides,
  };
}

function seededDb() {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  return db;
}

test('startScheduler runs the hourly pool-erinnerungen job on the configured interval (default 60 minutes)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const db = seededDb();
  let calls = 0;
  startScheduler({
    db,
    config: {},
    mailer: {},
    jobs: fakeJobs({ runPoolErinnerungenJob: async () => { calls += 1; return { status: 'erfolg' }; } }),
  });

  t.mock.timers.tick(60 * 60 * 1000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);

  t.mock.timers.tick(60 * 60 * 1000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
  db.close();
});

test('startScheduler picks up a saved cron_pool_erinnerungen_intervall_minuten change on the next tick', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const db = seededDb();
  let calls = 0;
  startScheduler({
    db,
    config: {},
    mailer: {},
    jobs: fakeJobs({ runPoolErinnerungenJob: async () => { calls += 1; return { status: 'erfolg' }; } }),
  });

  // Run 1 fires at +60min and reschedules using whatever the interval is *at that moment* --
  // still the default 60, since the config change below hasn't happened yet.
  t.mock.timers.tick(60 * 60 * 1000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);

  setConfigValue(db, 'cron_pool_erinnerungen_intervall_minuten', '15');

  // Run 2 fires 60 minutes after run 1 (it was already scheduled with the old interval before
  // the config change) -- but reschedules run 3 using the now-current 15-minute interval.
  t.mock.timers.tick(60 * 60 * 1000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);

  t.mock.timers.tick(15 * 60 * 1000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 3, 'run 3 must honor the shortened 15-minute interval, not wait another 60');
  db.close();
});

test('startScheduler runs the daily sync-personen job at its configured time (default 02:00), then again 24h later', async (t) => {
  // 2026-01-15T00:00:00Z is 01:00 in Zurich (CET) -- sync is scheduled for 02:00, one hour away.
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: new Date('2026-01-15T00:00:00.000Z') });
  const db = seededDb();
  let calls = 0;
  startScheduler({
    db,
    config: {},
    mailer: {},
    jobs: fakeJobs({ runSyncPersonenJob: async () => { calls += 1; return { status: 'erfolg' }; } }),
  });

  t.mock.timers.tick(60 * 60 * 1000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);

  t.mock.timers.tick(24 * 60 * 60 * 1000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
  db.close();
});

test('startScheduler runs sync-personen at a saved custom time instead of the default', async (t) => {
  // 2026-01-15T00:00:00Z is 01:00 in Zurich (CET).
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: new Date('2026-01-15T00:00:00.000Z') });
  const db = seededDb();
  setConfigValue(db, 'cron_sync_personen_stunde', '3');
  setConfigValue(db, 'cron_sync_personen_minute', '15');
  let calls = 0;
  startScheduler({
    db,
    config: {},
    mailer: {},
    jobs: fakeJobs({ runSyncPersonenJob: async () => { calls += 1; return { status: 'erfolg' }; } }),
  });

  // Default 02:00 would have fired by now -- the custom 03:15 must not have yet.
  t.mock.timers.tick(60 * 60 * 1000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 0, 'must not fire at the old default of 02:00');

  t.mock.timers.tick(75 * 60 * 1000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1, 'must fire at the configured 03:15');
  db.close();
});

test('startScheduler runs the daily pdf-bereinigung job at its own, later scheduled time (30 minutes after sync)', async (t) => {
  // 2026-01-15T00:00:00Z is 01:00 in Zurich (CET) -- pdf-bereinigung is scheduled for 02:30.
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: new Date('2026-01-15T00:00:00.000Z') });
  const db = seededDb();
  let calls = 0;
  startScheduler({
    db,
    config: {},
    mailer: {},
    jobs: fakeJobs({ runPdfBereinigungJob: () => { calls += 1; return { status: 'erfolg' }; } }),
  });

  t.mock.timers.tick(60 * 60 * 1000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 0, 'not yet 02:30');

  t.mock.timers.tick(30 * 60 * 1000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  db.close();
});
