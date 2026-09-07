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

test('seedDefaults sets footer_text default', () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  assert.equal(getConfigValue(db, 'footer_text'), 'Freigabeportal');
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

test('seedDefaults sets the SYNC-1/SYNC-2 sync-robustness defaults', () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  assert.equal(getConfigValue(db, 'sync_max_deaktivierung_prozent'), '50');
  assert.equal(getConfigValue(db, 'sync_max_deaktivierung_anzahl'), '10');
  assert.equal(getConfigValue(db, 'sync_fehler_empfaenger'), 'gruppe:admin');
  db.close();
});

test('seedDefaults sets zeitstempel defaults (feature disabled until a TSA URL is configured)', () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  assert.equal(getConfigValue(db, 'zeitstempel_tsa_url'), '');
  assert.equal(getConfigValue(db, 'zeitstempel_tsa_user'), '');
  assert.equal(getConfigValue(db, 'zeitstempel_tsa_passwort'), '');
  assert.equal(getConfigValue(db, 'cron_zeitstempel_nachholen_intervall_minuten'), '5');
  db.close();
});

test('seedDefaults sets zeitstempel_warnung_ab_stunden default', () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  assert.equal(getConfigValue(db, 'zeitstempel_warnung_ab_stunden'), '2');
  db.close();
});

test('seedDefaults sets modul_spesen_aktiv default (module enabled out of the box)', () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  assert.equal(getConfigValue(db, 'modul_spesen_aktiv'), '1');
  db.close();
});

test('seedDefaults sets kontierung_strikte_freigeber1_pruefung default (off out of the box)', () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  assert.equal(getConfigValue(db, 'kontierung_strikte_freigeber1_pruefung'), '0');
  db.close();
});

test('seedDefaults sets the 8 mail template defaults (betreff + text each)', () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  assert.equal(getConfigValue(db, 'mail_vorlage_zuweisung_betreff'), 'Freigabeportal: Neue Rechnung zur Bearbeitung');
  assert.equal(getConfigValue(db, 'mail_vorlage_reminder_betreff'), 'Freigabeportal: Rechnung wartet im Pool');
  assert.equal(getConfigValue(db, 'mail_vorlage_eskalation_betreff'), 'Freigabeportal: Eskalation – Rechnung seit langem unbeansprucht');
  assert.equal(getConfigValue(db, 'mail_vorlage_ablehnung_betreff'), 'Freigabeportal: Rechnung abgelehnt');
  assert.equal(getConfigValue(db, 'mail_vorlage_sync_fehler_betreff'), 'Freigabeportal: ChurchTools-Sync fehlgeschlagen');
  assert.equal(getConfigValue(db, 'mail_vorlage_iban_warnung_betreff'), 'Freigabeportal: IBAN-Abweichung bei Rechnung festgestellt');
  assert.equal(getConfigValue(db, 'mail_vorlage_rechnungsnummer_warnung_betreff'), 'Freigabeportal: Doppelte Rechnungsnummer festgestellt');
  assert.equal(getConfigValue(db, 'mail_vorlage_digest_betreff'), 'Freigabeportal: Tägliche Zusammenfassung (%anzahl% Ereignisse)');
  assert.match(getConfigValue(db, 'mail_vorlage_zuweisung_text'), /%empfaengerName%/);
  assert.match(getConfigValue(db, 'mail_vorlage_digest_text'), /%eintraege%/);
  db.close();
});

test('seedDefaults sets mail_batching_aktiv default (off out of the box)', () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  assert.equal(getConfigValue(db, 'mail_batching_aktiv'), '0');
  assert.equal(getConfigValue(db, 'mail_batching_stunde'), '7');
  assert.equal(getConfigValue(db, 'mail_batching_minute'), '0');
  db.close();
});

test('seedDefaults sets freigabe2 reminder/eskalation defaults', () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  assert.equal(getConfigValue(db, 'freigabe2_reminder_stunden'), '24');
  assert.equal(getConfigValue(db, 'freigabe2_eskalation_stunden'), '48');
  assert.equal(getConfigValue(db, 'freigabe2_eskalation_empfaenger'), 'gruppe:admin');
  assert.equal(getConfigValue(db, 'cron_freigabe2_erinnerungen_intervall_minuten'), '60');
  db.close();
});
