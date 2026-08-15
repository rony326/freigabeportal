import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';

test('openDatabase creates all expected tables', () => {
  const db = openDatabase(':memory:');
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  const names = rows.map((r) => r.name);
  for (const expected of ['personen', 'sessions', 'sync_log', 'admin_config', 'konten', 'zuweisungsregeln', 'jobs', 'freigaben']) {
    assert.ok(names.includes(expected), `missing table ${expected}`);
  }
  db.close();
});

test('openDatabase is idempotent (safe to call schema twice)', () => {
  const db = openDatabase(':memory:');
  assert.doesNotThrow(() => db.exec('SELECT 1'));
  db.close();
});

test('jobs table has a thumbnail_pfad column', () => {
  const db = openDatabase(':memory:');
  const columns = db.prepare("PRAGMA table_info(jobs)").all().map((c) => c.name);
  assert.ok(columns.includes('thumbnail_pfad'), 'jobs table is missing thumbnail_pfad');
  db.close();
});
