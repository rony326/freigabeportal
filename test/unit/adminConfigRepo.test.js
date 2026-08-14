import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { seedDefaults, getConfigValue, setConfigValue } from '../../src/db/adminConfigRepo.js';

test('seedDefaults sets reminder and escalation defaults', () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  assert.equal(getConfigValue(db, 'reminder_stunden'), '24');
  assert.equal(getConfigValue(db, 'eskalation_stunden'), '48');
  db.close();
});

test('seedDefaults does not overwrite an already-changed value', () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  setConfigValue(db, 'reminder_stunden', '12');
  seedDefaults(db);
  assert.equal(getConfigValue(db, 'reminder_stunden'), '12');
  db.close();
});

test('getConfigValue returns null for an unknown key', () => {
  const db = openDatabase(':memory:');
  assert.equal(getConfigValue(db, 'unknown'), null);
  db.close();
});

test('setConfigValue upserts a value', () => {
  const db = openDatabase(':memory:');
  setConfigValue(db, 'custom_key', 'first');
  setConfigValue(db, 'custom_key', 'second');
  assert.equal(getConfigValue(db, 'custom_key'), 'second');
  db.close();
});
