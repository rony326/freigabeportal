import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/db/index.js';
import { setConfigValue, getConfigValue, seedDefaults, deleteConfigValue, getDefaultConfigValue } from '../../src/db/adminConfigRepo.js';
import { upsertPerson, getPersonById } from '../../src/db/personenRepo.js';
import { listMailLog } from '../../src/db/mailLogRepo.js';
import { reiheBenachrichtigungEin, sendNotification, IMMER_SOFORT_TYPEN } from '../../src/services/notify.js';
import { runMailDigestJob, runMailZustellungJob } from '../../src/services/cronJobs.js';
import {
  BENACHRICHTIGUNG_WERTE,
  standardBenachrichtigung,
  benachrichtigungFuer,
  istDigestFaellig,
  setzeBenachrichtigung,
} from '../../src/services/benachrichtigung.js';

const CONFIG = { publicBaseUrl: 'http://portal.example.org' };
const ZWISCHEN_DIGEST_BETREFF = 'Freigabeportal: %zusammenfassung% Zusammenfassung (%anzahl% Ereignisse)';
const ZWISCHEN_DIGEST_TEXT = 'Hallo %empfaengerName%,\n\n%zusammenfassung% Zusammenfassung (Einstellung ändern: %einstellungenLink%)\n\nFolgende Ereignisse warten auf dich:\n\n%eintraege%\n\nBitte im Freigabeportal anmelden: %link%\n\nFreundliche Grüsse\n%portalName%';
const ALTER_DIGEST_BETREFF = 'Freigabeportal: Tägliche Zusammenfassung (%anzahl% Ereignisse)';
const ALTER_DIGEST_TEXT = 'Hallo %empfaengerName%,\n\nfolgende Ereignisse warten auf dich:\n\n%eintraege%\n\nBitte im Freigabeportal anmelden: %link%\n\nFreundliche Grüsse\n%portalName%';

// 2026-10-26 ist ein Montag, 2026-10-27 ein Dienstag (Zürich, nach Ende der Sommerzeit am 25.10.).
const MONTAG = new Date('2026-10-26T06:00:00.000Z');
const DIENSTAG = new Date('2026-10-27T06:00:00.000Z');

function stubMailer({ failFor = () => false } = {}) {
  const sent = [];
  return {
    sent,
    async sendMail(mail) {
      if (failFor(mail)) throw new Error('SMTP down');
      sent.push(mail);
    },
  };
}

function frischeDb() {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  return db;
}

function person(db, id, email, wahl) {
  upsertPerson(db, { id, vorname: `V${id}`, nachname: `N${id}`, email, gruppen: [] });
  if (wahl !== undefined) setzeBenachrichtigung(db, id, wahl);
}

function zuweisung(db, to, n = 1) {
  return reiheBenachrichtigungEin(db, {
    to,
    typ: 'zuweisung',
    jobId: null,
    variablen: { empfaengerName: 'X', jobDateiname: `r${n}.pdf`, grund: 'G', link: 'L' },
  });
}

function mitDateiDb(t) {
  const dir = mkdtempSync(join(tmpdir(), 'benachrichtigung-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'portal.db');
}

// --- Migration ---

test('Migration: altes Batching aktiv → Standard täglich', (t) => {
  const pfad = mitDateiDb(t);
  let db = openDatabase(pfad);
  seedDefaults(db);
  deleteConfigValue(db, 'mail_standard_benachrichtigung');
  setConfigValue(db, 'mail_batching_aktiv', '1');
  db.close();
  db = openDatabase(pfad);
  assert.equal(getConfigValue(db, 'mail_standard_benachrichtigung'), 'taeglich');
  db.close();
});

test('Migration: altes Batching aus → Standard sofort', (t) => {
  const pfad = mitDateiDb(t);
  let db = openDatabase(pfad);
  seedDefaults(db);
  deleteConfigValue(db, 'mail_standard_benachrichtigung');
  setConfigValue(db, 'mail_batching_aktiv', '0');
  db.close();
  db = openDatabase(pfad);
  assert.equal(getConfigValue(db, 'mail_standard_benachrichtigung'), 'sofort');
  db.close();
});

test('Migration ist idempotent: vorhandener Standard bleibt, auch wenn mail_batching_aktiv anders steht', (t) => {
  const pfad = mitDateiDb(t);
  let db = openDatabase(pfad);
  seedDefaults(db);
  deleteConfigValue(db, 'mail_standard_benachrichtigung');
  setConfigValue(db, 'mail_batching_aktiv', '1');
  db.close();
  db = openDatabase(pfad);
  setConfigValue(db, 'mail_standard_benachrichtigung', 'woechentlich');
  db.close();
  db = openDatabase(pfad);
  db.close();
  db = openDatabase(pfad);
  assert.equal(getConfigValue(db, 'mail_standard_benachrichtigung'), 'woechentlich');
  db.close();
});

test('Migration hebt die alte Standard-Digest-Vorlage, angepasste bleibt', (t) => {
  const pfad = mitDateiDb(t);
  let db = openDatabase(pfad);
  seedDefaults(db);
  setConfigValue(db, 'mail_vorlage_digest_betreff', ALTER_DIGEST_BETREFF);
  setConfigValue(db, 'mail_vorlage_digest_text', 'Eigener Text %eintraege%');
  db.close();
  db = openDatabase(pfad);
  assert.equal(getConfigValue(db, 'mail_vorlage_digest_betreff'), getDefaultConfigValue('mail_vorlage_digest_betreff'));
  assert.match(getConfigValue(db, 'mail_vorlage_digest_betreff'), /%zusammenfassung%/);
  assert.equal(getConfigValue(db, 'mail_vorlage_digest_text'), 'Eigener Text %eintraege%');
  db.close();

  db = openDatabase(pfad);
  setConfigValue(db, 'mail_vorlage_digest_betreff', 'Mein Betreff');
  setConfigValue(db, 'mail_vorlage_digest_text', ALTER_DIGEST_TEXT);
  db.close();
  db = openDatabase(pfad);
  assert.equal(getConfigValue(db, 'mail_vorlage_digest_betreff'), 'Mein Betreff');
  assert.equal(getConfigValue(db, 'mail_vorlage_digest_text'), getDefaultConfigValue('mail_vorlage_digest_text'));
  assert.match(getConfigValue(db, 'mail_vorlage_digest_text'), /%einstellungenLink%/);
  db.close();
});

test('seedDefaults: Standard sofort, Wochentag Montag', () => {
  const db = frischeDb();
  assert.equal(getConfigValue(db, 'mail_standard_benachrichtigung'), 'sofort');
  assert.equal(getConfigValue(db, 'mail_digest_wochentag'), '1');
  db.close();
});

// --- Zuordnung ---

test('BENACHRICHTIGUNG_WERTE', () => {
  assert.deepEqual(BENACHRICHTIGUNG_WERTE, ['sofort', 'taeglich', 'woechentlich']);
});

test('standardBenachrichtigung: gespeicherter Wert, ungültig → sofort', () => {
  const db = frischeDb();
  assert.equal(standardBenachrichtigung(db), 'sofort');
  setConfigValue(db, 'mail_standard_benachrichtigung', 'woechentlich');
  assert.equal(standardBenachrichtigung(db), 'woechentlich');
  setConfigValue(db, 'mail_standard_benachrichtigung', 'quatsch');
  assert.equal(standardBenachrichtigung(db), 'sofort');
  db.close();
});

test('benachrichtigungFuer: eigene Wahl, Standard, unbekannte Adresse, Gross/Klein', () => {
  const db = frischeDb();
  setConfigValue(db, 'mail_standard_benachrichtigung', 'taeglich');
  person(db, '1', 'Ana@Example.org', 'woechentlich');
  person(db, '2', 'bo@example.org');
  assert.equal(benachrichtigungFuer(db, 'ana@example.org'), 'woechentlich');
  assert.equal(benachrichtigungFuer(db, ' ANA@EXAMPLE.ORG '), 'woechentlich');
  assert.equal(benachrichtigungFuer(db, 'bo@example.org'), 'taeglich', 'Person ohne Wahl → Standard');
  assert.equal(benachrichtigungFuer(db, 'frei@example.org'), 'taeglich', 'Adresse ohne Person → Standard');
  assert.equal(benachrichtigungFuer(db, ''), 'taeglich');
  db.close();
});

test('benachrichtigungFuer: zwei Personen mit derselben Adresse → kürzeste Bündelung', () => {
  const db = frischeDb();
  setConfigValue(db, 'mail_standard_benachrichtigung', 'woechentlich');
  person(db, '1', 'familie@example.org', 'woechentlich');
  person(db, '2', 'Familie@example.org', 'taeglich');
  assert.equal(benachrichtigungFuer(db, 'familie@example.org'), 'taeglich');
  setzeBenachrichtigung(db, '2', null);
  assert.equal(benachrichtigungFuer(db, 'familie@example.org'), 'woechentlich', 'NULL zählt als Standard');
  setConfigValue(db, 'mail_standard_benachrichtigung', 'sofort');
  assert.equal(benachrichtigungFuer(db, 'familie@example.org'), 'sofort');
  db.close();
});

test('setzeBenachrichtigung: speichert, NULL setzt zurück, ungültig wirft', () => {
  const db = frischeDb();
  person(db, '1', 'a@example.org');
  setzeBenachrichtigung(db, '1', 'woechentlich');
  assert.equal(getPersonById(db, '1').benachrichtigung, 'woechentlich');
  setzeBenachrichtigung(db, '1', null);
  assert.equal(getPersonById(db, '1').benachrichtigung, null);
  assert.throws(() => setzeBenachrichtigung(db, '1', 'monatlich'));
  db.close();
});

// --- Wochentag ---

test('istDigestFaellig: sofort und täglich immer, wöchentlich nur am Wochentag', () => {
  assert.equal(istDigestFaellig('sofort', DIENSTAG, '1'), true);
  assert.equal(istDigestFaellig('taeglich', DIENSTAG, '1'), true);
  assert.equal(istDigestFaellig('woechentlich', DIENSTAG, '1'), false);
  assert.equal(istDigestFaellig('woechentlich', MONTAG, '1'), true);
  assert.equal(istDigestFaellig('woechentlich', DIENSTAG, '2'), true);
  assert.equal(istDigestFaellig('woechentlich', new Date('2026-11-01T10:00:00.000Z'), '7'), true, 'Sonntag = 7');
});

test('istDigestFaellig: Zürcher Datum zählt, nicht UTC (Winter- und Sommerzeit)', () => {
  // Winterzeit (UTC+1): Sonntag 23:30 UTC ist in Zürich bereits Montag 00:30.
  assert.equal(istDigestFaellig('woechentlich', new Date('2026-10-25T23:30:00.000Z'), '1'), true);
  // Montag 23:30 UTC ist in Zürich bereits Dienstag.
  assert.equal(istDigestFaellig('woechentlich', new Date('2026-10-26T23:30:00.000Z'), '1'), false);
  // Sommerzeit (UTC+2): Sonntag 22:30 UTC ist Montag 00:30 in Zürich; 21:30 UTC noch Sonntag.
  assert.equal(istDigestFaellig('woechentlich', new Date('2026-03-29T22:30:00.000Z'), '1'), true);
  assert.equal(istDigestFaellig('woechentlich', new Date('2026-03-29T21:30:00.000Z'), '1'), false);
  // Tag der Umstellung (So 29.03.2026, 01:30 UTC = 03:30 MESZ): Sonntag.
  assert.equal(istDigestFaellig('woechentlich', new Date('2026-03-29T01:30:00.000Z'), '7'), true);
  // Akzeptiert auch Zahl und Millisekunden.
  assert.equal(istDigestFaellig('woechentlich', MONTAG.getTime(), 1), true);
});

// --- Einreihen ---

test('Einreihen: sofort → eingereiht, täglich/wöchentlich → geplant', () => {
  const db = frischeDb();
  person(db, '1', 'sofort@example.org', 'sofort');
  person(db, '2', 'taeglich@example.org', 'taeglich');
  person(db, '3', 'woche@example.org', 'woechentlich');
  assert.equal(zuweisung(db, 'sofort@example.org').status, 'eingereiht');
  assert.equal(zuweisung(db, 'taeglich@example.org').status, 'geplant');
  assert.equal(zuweisung(db, 'woche@example.org').status, 'geplant');
  assert.equal(zuweisung(db, 'frei@example.org').status, 'eingereiht', 'Standard sofort');
  setConfigValue(db, 'mail_standard_benachrichtigung', 'taeglich');
  assert.equal(zuweisung(db, 'frei@example.org').status, 'geplant', 'Standard täglich');
  db.close();
});

test('mail_batching_aktiv wird nicht mehr gelesen', () => {
  const db = frischeDb();
  setConfigValue(db, 'mail_batching_aktiv', '1');
  assert.equal(zuweisung(db, 'frei@example.org').status, 'eingereiht');
  db.close();
});

test('Erinnerungen, Eskalationen und Warnungen gehen bei "wöchentlich" immer sofort', async () => {
  const db = frischeDb();
  person(db, '1', 'woche@example.org', 'woechentlich');
  const typen = [
    'reminder', 'eskalation', 'freigabe2-reminder', 'freigabe2-eskalation', 'kk-beleg-erinnerung',
    'sicherheitsalarm', 'duplikat-warnung', 'rechnungsnummer-warnung', 'iban-warnung', 'sync-fehler',
    'admin-umzuweisung', 'kk-beleg-eingegangen', 'audit-pruefnummer', 'neues-geraet', 'fehlermeldung', 'testmail',
  ];
  for (const typ of typen) {
    assert.ok(IMMER_SOFORT_TYPEN.has(typ), typ);
    const e = reiheBenachrichtigungEin(db, { to: 'woche@example.org', typ, jobId: null, gerendert: { subject: typ, text: 'T' } });
    assert.equal(e.status, 'eingereiht', `${typ} muss sofort gehen`);
  }
  // Ende-zu-Ende mit Vorlage: die Erinnerung geht direkt per SMTP raus.
  const mailer = stubMailer();
  const r = await sendNotification(db, mailer, { to: 'woche@example.org', typ: 'reminder', jobId: null, variablen: { jobDateiname: 'a.pdf', stunden: 24, link: 'L' } });
  assert.equal(r.status, 'versendet');
  assert.equal(mailer.sent.length, 1);
  assert.equal(listMailLog(db).filter((m) => m.status === 'geplant').length, 0);
  db.close();
});

test('kommentar folgt der persönlichen Wahl', () => {
  const db = frischeDb();
  person(db, '1', 'woche@example.org', 'woechentlich');
  const e = reiheBenachrichtigungEin(db, { to: 'woche@example.org', typ: 'kommentar', jobId: null, gerendert: { subject: 'S', text: 'T' } });
  assert.equal(e.status, 'geplant');
  db.close();
});

// --- Digest-Lauf ---

test('Digest Dienstag: täglich versendet, wöchentlich (Montag) zurückgestellt; Montag: beide', async () => {
  const db = frischeDb();
  person(db, '1', 'taeglich@example.org', 'taeglich');
  person(db, '2', 'woche@example.org', 'woechentlich');
  zuweisung(db, 'taeglich@example.org', 1);
  zuweisung(db, 'woche@example.org', 2);
  zuweisung(db, 'woche@example.org', 3);

  const dienstag = stubMailer();
  const r1 = await runMailDigestJob(db, CONFIG, dienstag, { jetzt: DIENSTAG });
  assert.equal(r1.status, 'erfolg');
  assert.equal(r1.versendet, 1);
  assert.equal(r1.zurueckgestellt, 1);
  assert.deepEqual(dienstag.sent.map((m) => m.to), ['taeglich@example.org']);
  assert.match(dienstag.sent[0].subject, /Deine tägliche Zusammenfassung/);
  assert.equal(listMailLog(db).filter((m) => m.empfaenger === 'woche@example.org' && m.status === 'geplant').length, 2);

  const montag = stubMailer();
  zuweisung(db, 'taeglich@example.org', 4);
  const r2 = await runMailDigestJob(db, CONFIG, montag, { jetzt: new Date('2026-11-02T06:00:00.000Z') });
  assert.equal(r2.versendet, 2);
  assert.equal(r2.zurueckgestellt, 0);
  const anWoche = montag.sent.find((m) => m.to === 'woche@example.org');
  assert.match(anWoche.subject, /Deine wöchentliche Zusammenfassung \(2 Ereignisse\)/);
  assert.match(anWoche.text, /http:\/\/portal\.example\.org\/meine-benachrichtigungen/);
  assert.ok(listMailLog(db).every((m) => m.status === 'versendet'));
  db.close();
});

test('Wechsel täglich → wöchentlich nach dem Einreihen: wartet bis zum Wochentag, geht dann vollständig raus', async () => {
  const db = frischeDb();
  person(db, '1', 'a@example.org', 'taeglich');
  zuweisung(db, 'a@example.org', 1);
  zuweisung(db, 'a@example.org', 2);
  setzeBenachrichtigung(db, '1', 'woechentlich');

  const dienstag = stubMailer();
  const r1 = await runMailDigestJob(db, CONFIG, dienstag, { jetzt: DIENSTAG });
  assert.equal(dienstag.sent.length, 0);
  assert.equal(r1.zurueckgestellt, 1);
  assert.ok(listMailLog(db).every((m) => m.status === 'geplant'));

  const montag = stubMailer();
  await runMailDigestJob(db, CONFIG, montag, { jetzt: new Date('2026-11-02T06:00:00.000Z') });
  assert.equal(montag.sent.length, 1);
  assert.match(montag.sent[0].subject, /2 Ereignisse/);
  assert.ok(listMailLog(db).every((m) => m.status === 'versendet'));
  db.close();
});

test('Wechsel wöchentlich → sofort: Geplantes geht beim nächsten Lauf auch ausserhalb des Wochentags raus', async () => {
  const db = frischeDb();
  person(db, '1', 'a@example.org', 'woechentlich');
  zuweisung(db, 'a@example.org', 1);
  setzeBenachrichtigung(db, '1', 'sofort');
  const mailer = stubMailer();
  const r = await runMailDigestJob(db, CONFIG, mailer, { jetzt: DIENSTAG });
  assert.equal(r.versendet, 1);
  assert.equal(r.zurueckgestellt, 0);
  assert.ok(listMailLog(db).every((m) => m.status === 'versendet'));
  db.close();
});

test('Keine Doppelzustellung bei zwei Läufen am selben Tag', async () => {
  const db = frischeDb();
  person(db, '1', 'woche@example.org', 'woechentlich');
  person(db, '2', 'taeglich@example.org', 'taeglich');
  zuweisung(db, 'woche@example.org', 1);
  zuweisung(db, 'taeglich@example.org', 2);
  const mailer = stubMailer();
  await runMailDigestJob(db, CONFIG, mailer, { jetzt: MONTAG });
  await runMailDigestJob(db, CONFIG, mailer, { jetzt: MONTAG });
  assert.equal(mailer.sent.length, 2);
  assert.equal(new Set(mailer.sent.map((m) => m.to)).size, 2);
  db.close();
});

test('Gescheiterter wöchentlicher Digest wird am Folgetag wiederholt, nicht bis zur nächsten Woche zurückgestellt', async () => {
  const db = frischeDb();
  person(db, '1', 'woche@example.org', 'woechentlich');
  zuweisung(db, 'woche@example.org', 1);
  const kaputt = stubMailer({ failFor: () => true });
  const r1 = await runMailDigestJob(db, CONFIG, kaputt, { jetzt: MONTAG });
  assert.equal(r1.wiederholung, 1);
  assert.equal(listMailLog(db)[0].versuche, 1);

  // Neue Zeile kommt dazu; am Dienstag wird nur die begonnene Wiederholung zugestellt.
  zuweisung(db, 'woche@example.org', 2);
  const heil = stubMailer();
  const r2 = await runMailDigestJob(db, CONFIG, heil, { jetzt: DIENSTAG });
  assert.equal(heil.sent.length, 1);
  assert.match(heil.sent[0].subject, /Deine wöchentliche Zusammenfassung \(1 Ereignisse\)/);
  assert.equal(r2.zurueckgestellt, 1);
  const rows = listMailLog(db);
  assert.equal(rows.filter((m) => m.status === 'versendet').length, 1);
  assert.equal(rows.filter((m) => m.status === 'geplant').length, 1);
  db.close();
});

test('Wiederholungsjob mail-zustellung stellt einen gescheiterten wöchentlichen Digest unabhängig vom Wochentag zu', async () => {
  const db = frischeDb();
  person(db, '1', 'woche@example.org', 'woechentlich');
  zuweisung(db, 'woche@example.org', 1);
  await runMailDigestJob(db, CONFIG, stubMailer({ failFor: () => true }), { jetzt: MONTAG });
  db.prepare("UPDATE mail_log SET naechster_versuch_am = '2000-01-01T00:00:00.000Z'").run();
  const heil = stubMailer();
  const r = await runMailZustellungJob(db, CONFIG, heil);
  assert.equal(r.status, 'erfolg');
  assert.equal(heil.sent.length, 1);
  assert.match(heil.sent[0].subject, /wöchentliche/);
  db.close();
});

test('Digest-Wochentag aus mail_digest_wochentag', async () => {
  const db = frischeDb();
  setConfigValue(db, 'mail_digest_wochentag', '2');
  person(db, '1', 'woche@example.org', 'woechentlich');
  zuweisung(db, 'woche@example.org', 1);
  const mailer = stubMailer();
  const r = await runMailDigestJob(db, CONFIG, mailer, { jetzt: DIENSTAG });
  assert.equal(r.versendet, 1);
  db.close();
});

// --- Nachträge Task 2 ---

test('Migration hebt auch die Zwischen-Vorlage (Task 1, nie ausgeliefert) auf den neuen Standard', (t) => {
  const pfad = mitDateiDb(t);
  let db = openDatabase(pfad);
  seedDefaults(db);
  setConfigValue(db, 'mail_vorlage_digest_betreff', ZWISCHEN_DIGEST_BETREFF);
  setConfigValue(db, 'mail_vorlage_digest_text', ZWISCHEN_DIGEST_TEXT);
  db.close();
  db = openDatabase(pfad);
  assert.equal(getConfigValue(db, 'mail_vorlage_digest_betreff'), getDefaultConfigValue('mail_vorlage_digest_betreff'));
  assert.equal(getConfigValue(db, 'mail_vorlage_digest_text'), getDefaultConfigValue('mail_vorlage_digest_text'));
  db.close();
});

test('Standard-Digest-Vorlage: "Deine tägliche/wöchentliche Zusammenfassung"', () => {
  const db = frischeDb();
  assert.match(getDefaultConfigValue('mail_vorlage_digest_betreff'), /Deine %zusammenfassung% Zusammenfassung/);
  assert.match(getDefaultConfigValue('mail_vorlage_digest_text'), /Deine %zusammenfassung% Zusammenfassung \(Einstellung ändern: %einstellungenLink%\)/);
  db.close();
});

test('benachrichtigungFuer: aktive Person geht vor deaktivierter mit gleicher Adresse', () => {
  const db = frischeDb();
  setConfigValue(db, 'mail_standard_benachrichtigung', 'taeglich');
  person(db, '1', 'geteilt@example.org', 'woechentlich');
  person(db, '2', 'geteilt@example.org');
  db.prepare('UPDATE personen SET aktiv = 0 WHERE churchtools_person_id = ?').run('1');
  assert.equal(benachrichtigungFuer(db, 'geteilt@example.org'), 'taeglich');
  db.close();
});

test('istDigestFaellig: wöchentlich ist auch ausserhalb des Wochentags fällig, wenn die älteste Zeile >= 7 Tage alt ist', () => {
  assert.equal(istDigestFaellig('woechentlich', DIENSTAG, 1), false);
  assert.equal(istDigestFaellig('woechentlich', DIENSTAG, 1, '2026-10-20T06:00:00.000Z'), true, 'genau 7 Tage');
  assert.equal(istDigestFaellig('woechentlich', DIENSTAG, 1, '2026-10-21T06:00:00.000Z'), false, '6 Tage');
});

test('Digest-Job: verpasster Wochenlauf wird nachgeholt (älteste geplante Zeile >= 7 Tage)', async () => {
  const db = frischeDb();
  person(db, '1', 'woche@example.org', 'woechentlich');
  zuweisung(db, 'woche@example.org', 1);
  db.prepare("UPDATE mail_log SET versucht_am = '2026-10-20T05:00:00.000Z'").run();
  const mailer = stubMailer();
  const r = await runMailDigestJob(db, CONFIG, mailer, { jetzt: DIENSTAG });
  assert.equal(r.versendet, 1);
  assert.equal(r.zurueckgestellt, 0);
  assert.equal(mailer.sent.length, 1);
  db.close();
});
