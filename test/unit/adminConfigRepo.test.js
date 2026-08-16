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

test('seedDefaults sets branding defaults', () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  assert.equal(getConfigValue(db, 'branding_farbe_primaer'), '#2f4858');
  assert.equal(getConfigValue(db, 'branding_farbe_sekundaer'), '#4d7ea8');
  assert.equal(getConfigValue(db, 'branding_theme_default'), 'system');
  db.close();
});

test('seedDefaults sets visum_seite_position default', () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  assert.equal(getConfigValue(db, 'visum_seite_position'), 'letzte');
  db.close();
});

test('seedDefaults sets reminder_empfaenger and eskalation_empfaenger defaults', () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  assert.equal(getConfigValue(db, 'reminder_empfaenger'), 'gruppe:buchhaltung');
  assert.equal(getConfigValue(db, 'eskalation_empfaenger'), 'gruppe:buchhaltung');
  db.close();
});

test('seedDefaults sets mail_log_aufbewahrung_tage default', () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  assert.equal(getConfigValue(db, 'mail_log_aufbewahrung_tage'), '90');
  db.close();
});
