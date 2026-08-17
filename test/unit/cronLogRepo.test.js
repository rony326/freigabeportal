import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { logCronLauf, listRecentCronLog } from '../../src/db/cronLogRepo.js';

test('logCronLauf inserts a row and returns its id', () => {
  const db = openDatabase(':memory:');
  const id = logCronLauf(db, {
    job: 'pool-erinnerungen',
    gestartetAm: '2026-08-17T02:00:00.000Z',
    beendetAm: '2026-08-17T02:00:01.000Z',
    status: 'erfolg',
    details: 'Reminder: 2, Eskalation: 0',
  });
  assert.equal(typeof id, 'number');
  const rows = listRecentCronLog(db, 'pool-erinnerungen', 10);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, id);
  assert.equal(rows[0].status, 'erfolg');
  assert.equal(rows[0].details, 'Reminder: 2, Eskalation: 0');
  db.close();
});

test('listRecentCronLog only returns rows for the requested job, newest first, capped at limit', () => {
  const db = openDatabase(':memory:');
  logCronLauf(db, { job: 'pool-erinnerungen', gestartetAm: 't1', beendetAm: 't1', status: 'erfolg', details: 'erste' });
  logCronLauf(db, { job: 'pdf-bereinigung', gestartetAm: 't2', beendetAm: 't2', status: 'erfolg', details: 'anderer job' });
  logCronLauf(db, { job: 'pool-erinnerungen', gestartetAm: 't3', beendetAm: 't3', status: 'fehler', details: 'zweite' });

  const rows = listRecentCronLog(db, 'pool-erinnerungen', 10);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].details, 'zweite', 'newest first');
  assert.equal(rows[1].details, 'erste');

  const capped = listRecentCronLog(db, 'pool-erinnerungen', 1);
  assert.equal(capped.length, 1);
  assert.equal(capped[0].details, 'zweite');
  db.close();
});

test('logCronLauf stores a null details value as null, not the string "null"', () => {
  const db = openDatabase(':memory:');
  logCronLauf(db, { job: 'pdf-bereinigung', gestartetAm: 't1', beendetAm: 't1', status: 'erfolg' });
  const rows = listRecentCronLog(db, 'pdf-bereinigung', 10);
  assert.equal(rows[0].details, null);
  db.close();
});
