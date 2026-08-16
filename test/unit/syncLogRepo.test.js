import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { startSyncLog, finishSyncLog, hasRecentRunningSync, listRecentSyncLogs } from '../../src/db/syncLogRepo.js';

test('startSyncLog then finishSyncLog records a completed run', () => {
  const db = openDatabase(':memory:');
  const id = startSyncLog(db);
  finishSyncLog(db, id, { status: 'erfolg', anzahlUpserted: 3, anzahlDeaktiviert: 1, fehlerDetails: null });
  const row = db.prepare('SELECT * FROM sync_log WHERE id = ?').get(id);
  assert.equal(row.status, 'erfolg');
  assert.equal(row.anzahl_upserted, 3);
  assert.ok(row.beendet_am);
  db.close();
});

test('hasRecentRunningSync is true right after startSyncLog and false after finishSyncLog', () => {
  const db = openDatabase(':memory:');
  const id = startSyncLog(db);
  assert.equal(hasRecentRunningSync(db), true);
  finishSyncLog(db, id, { status: 'erfolg' });
  assert.equal(hasRecentRunningSync(db), false);
  db.close();
});

test('hasRecentRunningSync ignores a stale (older than threshold) running entry', () => {
  const db = openDatabase(':memory:');
  const id = startSyncLog(db);
  const staleTimestamp = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  db.prepare('UPDATE sync_log SET gestartet_am = ? WHERE id = ?').run(staleTimestamp, id);
  assert.equal(hasRecentRunningSync(db, 10 * 60 * 1000), false);
  db.close();
});

test('listRecentSyncLogs returns the most recent runs first, capped at the given limit', () => {
  const db = openDatabase(':memory:');
  const id1 = startSyncLog(db);
  finishSyncLog(db, id1, { status: 'erfolg', anzahlUpserted: 1, anzahlDeaktiviert: 0 });
  const id2 = startSyncLog(db);
  finishSyncLog(db, id2, { status: 'abgebrochen', fehlerDetails: 'zu viele Deaktivierungen' });

  const rows = listRecentSyncLogs(db, 1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, id2);
  assert.equal(rows[0].status, 'abgebrochen');
  db.close();
});
