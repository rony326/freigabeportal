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

test('admin-umzuweisung hat eine Standardvorlage mit Bemerkung und Link', () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  const vorlage = getVorlage(db, 'admin-umzuweisung');
  assert.match(vorlage.betreff, /übergeben/);
  for (const variable of ['%empfaengerName%', '%grund%', '%jobDateiname%', '%adminName%', '%bemerkung%', '%link%']) {
    assert.ok(vorlage.text.includes(variable), variable);
  }
  db.close();
});

test('getVorlage liefert die drei Rapport-Vorlagen mit ihren Variablen', () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  const erwartet = {
    'rapport-zuweisung': ['%empfaengerName%', '%jobDateiname%', '%markiertVon%', '%bemerkung%', '%link%'],
    'rapport-reminder': ['%empfaengerName%', '%jobDateiname%', '%stunden%', '%link%'],
    'rapport-eskalation': ['%jobDateiname%', '%stunden%', '%offenePersonen%', '%link%'],
  };
  for (const [typ, variablen] of Object.entries(erwartet)) {
    const vorlage = getVorlage(db, typ);
    assert.ok(vorlage.betreff && vorlage.betreff.trim(), `${typ}: Betreff leer`);
    assert.ok(vorlage.text && vorlage.text.trim(), `${typ}: Text leer`);
    for (const v of variablen) assert.ok(vorlage.text.includes(v), `${typ}: ${v} fehlt im Text`);
    assert.doesNotMatch(vorlage.betreff + vorlage.text, /ß/);
  }
  db.close();
});

test('auffaelligkeiten-warnung hat die Standardtexte; iban-warnung gibt es nicht mehr', () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  const vorlage = getVorlage(db, 'auffaelligkeiten-warnung');
  assert.equal(vorlage.betreff, 'Freigabeportal: Auffälligkeiten bei Rechnung %jobDateiname%');
  assert.equal(
    vorlage.text,
    'Hallo\n\n%bestaetigtVon% hat die Rechnung "%jobDateiname%" (Lieferant: %kreditorName%) trotz folgender Auffälligkeiten kontiert:\n\n%auffaelligkeiten%\n\nWie geprüft: %bemerkung%\n\nBitte schau sie dir vor der Freigabe genau an: %link%\n\nFreundliche Grüsse\n%portalName%',
  );
  assert.throws(() => getVorlage(db, 'iban-warnung'), /Unbekannter Mail-Vorlagen-Typ/);
  db.close();
});
