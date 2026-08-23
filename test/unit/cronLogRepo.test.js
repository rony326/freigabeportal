import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { logCronLauf, listRecentCronLog, startCronLauf, finishCronLauf, hasRecentRunningCronLauf } from '../../src/db/cronLogRepo.js';

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

test('startCronLauf then finishCronLauf records a completed run', () => {
  const db = openDatabase(':memory:');
  const id = startCronLauf(db, 'zeitstempel-nachholen');
  finishCronLauf(db, id, { beendetAm: '2026-08-22T00:00:01.000Z', status: 'erfolg', details: 'Nachgeholt: 2, Fehlgeschlagen: 0, Datei fehlt: 0' });
  const row = db.prepare('SELECT * FROM cron_log WHERE id = ?').get(id);
  assert.equal(row.job, 'zeitstempel-nachholen');
  assert.equal(row.status, 'erfolg');
  assert.equal(row.beendet_am, '2026-08-22T00:00:01.000Z');
  assert.equal(row.details, 'Nachgeholt: 2, Fehlgeschlagen: 0, Datei fehlt: 0');
  db.close();
});

test('hasRecentRunningCronLauf is true right after startCronLauf and false after finishCronLauf', () => {
  const db = openDatabase(':memory:');
  const id = startCronLauf(db, 'zeitstempel-nachholen');
  assert.equal(hasRecentRunningCronLauf(db, 'zeitstempel-nachholen'), true);
  finishCronLauf(db, id, { beendetAm: new Date().toISOString(), status: 'erfolg', details: null });
  assert.equal(hasRecentRunningCronLauf(db, 'zeitstempel-nachholen'), false);
  db.close();
});

test('hasRecentRunningCronLauf ignores a stale (older than threshold) running entry', () => {
  const db = openDatabase(':memory:');
  const id = startCronLauf(db, 'zeitstempel-nachholen');
  const staleTimestamp = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  db.prepare('UPDATE cron_log SET gestartet_am = ? WHERE id = ?').run(staleTimestamp, id);
  assert.equal(hasRecentRunningCronLauf(db, 'zeitstempel-nachholen', 10 * 60 * 1000), false);
  db.close();
});

test('hasRecentRunningCronLauf only looks at the requested job, not other laufend rows', () => {
  const db = openDatabase(':memory:');
  startCronLauf(db, 'zeitstempel-nachholen');
  assert.equal(hasRecentRunningCronLauf(db, 'pool-erinnerungen'), false, 'pool-erinnerungen never writes laufend rows, but must not be confused with an unrelated job that is');
  db.close();
});
