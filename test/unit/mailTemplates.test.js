import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { seedDefaults, setConfigValue } from '../../src/db/adminConfigRepo.js';
import { renderTemplate, getVorlage } from '../../src/services/mailTemplates.js';

test('renderTemplate replaces every occurrence of a known placeholder', () => {
  const result = renderTemplate('Hallo %name%, %name% hat Post.', { name: 'Erika' });
  assert.equal(result, 'Hallo Erika, Erika hat Post.');
});

test('renderTemplate leaves unknown placeholders untouched', () => {
  const result = renderTemplate('Hallo %name%, dein %unbekannt% bleibt stehen.', { name: 'Erika' });
  assert.equal(result, 'Hallo Erika, dein %unbekannt% bleibt stehen.');
});

test('renderTemplate coerces non-string variable values to strings', () => {
  const result = renderTemplate('Anzahl: %anzahl%', { anzahl: 3 });
  assert.equal(result, 'Anzahl: 3');
});

test('getVorlage reads betreff and text for a given typ from admin_config', () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  const vorlage = getVorlage(db, 'reminder');
  assert.equal(vorlage.betreff, 'Freigabeportal: Rechnung wartet im Pool');
  assert.match(vorlage.text, /%stunden%/);
  db.close();
});

test('getVorlage reflects an admin-edited template', () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  setConfigValue(db, 'mail_vorlage_reminder_betreff', 'Angepasster Betreff');
  const vorlage = getVorlage(db, 'reminder');
  assert.equal(vorlage.betreff, 'Angepasster Betreff');
  db.close();
});

test('getVorlage maps hyphenated typ values to their underscore admin_config key', () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  const vorlage = getVorlage(db, 'sync-fehler');
  assert.equal(vorlage.betreff, 'Freigabeportal: ChurchTools-Sync fehlgeschlagen');
  db.close();
});

test('getVorlage supports the digest pseudo-typ', () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  const vorlage = getVorlage(db, 'digest');
  assert.match(vorlage.text, /%eintraege%/);
  db.close();
});

test('getVorlage throws for an unknown typ', () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  assert.throws(() => getVorlage(db, 'unbekannt'));
  db.close();
});

test('getVorlage resolves freigabe2-reminder and freigabe2-eskalation after seedDefaults', () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  const reminder = getVorlage(db, 'freigabe2-reminder');
  assert.ok(reminder.betreff.length > 0);
  assert.ok(reminder.text.includes('%stunden%'));
  const eskalation = getVorlage(db, 'freigabe2-eskalation');
  assert.ok(eskalation.betreff.length > 0);
  assert.ok(eskalation.text.includes('%stunden%'));
  db.close();
});
