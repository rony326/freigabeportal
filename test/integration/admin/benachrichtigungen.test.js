// Admin-Seite "Benachrichtigungen" (ein Ereignis pro URL) gegen die echte App-Verdrahtung:
// Rechte, CSRF, Speichern pro Ereignis, Zurücksetzen, Test-Mail, Weiterleitungen der alten Seiten.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../../src/db/index.js';
import { seedDefaults, getConfigValue, setConfigValue, DEFAULTS } from '../../../src/db/adminConfigRepo.js';
import { upsertPerson } from '../../../src/db/personenRepo.js';
import { setzeBenachrichtigung, zuercherWochentag } from '../../../src/services/benachrichtigung.js';
import { reiheBenachrichtigungEin } from '../../../src/services/notify.js';
import { createApp } from '../../../src/app.js';

function testConfig(dir) {
  return {
    sessionSecret: 'test-secret',
    env: 'test',
    // http: sonst setzt csrf-csrf ein Secure-Cookie, das supertest nicht zurückschickt.
    publicBaseUrl: 'http://portal.example.org',
    churchtools: {
      baseUrl: 'https://ct.example.org', clientId: 'client-id', clientSecret: 'client-secret',
      redirectUri: 'https://portal.example.org/auth/callback', groupIdBuchhaltung: '10', groupIdAdmin: '20', groupIdManager: '30', syncServiceToken: 'token',
    },
    cronSecret: 'cron-secret',
    n8nApiKey: 'n8n-key',
    smtp: { host: 'smtp.example.org', port: 587, user: 'user', pass: 'pass', from: 'portal@example.org' },
    brandingDir: dir, jobsDir: dir, backupDir: dir,
    downloadSigningSecret: 'download-secret',
  };
}

function umgebung(t) {
  const dir = mkdtempSync(join(tmpdir(), 'benachrichtigungen-'));
  const db = openDatabase(':memory:');
  seedDefaults(db);
  upsertPerson(db, { id: '1', vorname: 'Paula', nachname: 'Person', email: 'paula@example.org', gruppen: ['10'], loggedInNow: true });
  upsertPerson(db, { id: '55', vorname: 'Mana', nachname: 'Ger', email: 'manager@example.org', gruppen: ['30'], loggedInNow: true });
  upsertPerson(db, { id: '99', vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'], loggedInNow: true });
  const mailer = { sent: [], async sendMail(m) { this.sent.push(m); } };
  const app = createApp({ db, config: testConfig(dir), mailer });
  const aussen = express();
  aussen.use((req, res, next) => {
    const personId = req.headers['x-test-person-id'];
    req.session = { id: `sitzung-${personId}`, personId };
    app(req, res, next);
  });
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const als = (personId = '99') => request.agent(aussen).set('x-test-person-id', personId);
  return { db, mailer, als };
}

const csrfAus = (text) => {
  const m = text.match(/name="_csrf" value="([^"]+)"/);
  if (!m) throw new Error('kein _csrf-Feld');
  return m[1];
};

// Lädt die Seite des Ereignisses (für CSRF-Token) und schickt das Formular mit den
// angezeigten Werten, überschrieben durch `felder`.
async function sende(agent, id, felder = {}, pfad = '') {
  const seite = await agent.get(`/admin/benachrichtigungen/${id}`);
  assert.equal(seite.status, 200, `GET ${id}`);
  return agent.post(`/admin/benachrichtigungen/${id}${pfad}`).type('form').send({ _csrf: csrfAus(seite.text), ...felder });
}

const REMINDER = {
  zeit_reminder_stunden: '24',
  empfaenger: 'gruppe:buchhaltung',
  betreff: DEFAULTS.mail_vorlage_reminder_betreff,
  text: DEFAULTS.mail_vorlage_reminder_text,
};

const ZUSAMMENFASSUNG = {
  zeit_mail_standard_benachrichtigung: 'taeglich',
  zeit_mail_digest_wochentag: '3',
  zeit_mail_batching_stunde: '6',
  zeit_mail_batching_minute: '30',
  betreff: DEFAULTS.mail_vorlage_digest_betreff,
  text: DEFAULTS.mail_vorlage_digest_text,
};

const AUDIT = {
  empfaenger: '',
  betreff: DEFAULTS.mail_vorlage_audit_pruefnummer_betreff,
  text: DEFAULTS.mail_vorlage_audit_pruefnummer_text,
};

// Ohne Textarea, Hilfetext und Datenelement für das Browser-Skript (dort stehen die Werte bewusst roh).
const ohneHilfe = (html) => html.replace(/<textarea[\s\S]*?<\/textarea>/g, '').replace(/<script type="application\/json"[\s\S]*?<\/script>/g, '').replace(/<div class="form-text" id="empfaengerHilfe">[\s\S]*?<\/div>/g, '');
const listenEintrag = (html, id) => html.match(new RegExp(`<a[^>]*href="/admin/benachrichtigungen/${id}"[\\s\\S]*?</a>`))[0];

test('GET /admin/benachrichtigungen leitet auf das erste Ereignis, unbekanntes Ereignis → 404', async (t) => {
  const { als } = umgebung(t);
  const res = await als().get('/admin/benachrichtigungen');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/admin/benachrichtigungen/zusammenfassung');
  assert.equal((await als().get('/admin/benachrichtigungen/gibt-es-nicht')).status, 404);
});

test('Erinnerung zeigt Wann, Stunden, Empfänger lesbar und das Betreff-Feld', async (t) => {
  const { als } = umgebung(t);
  const res = await als().get('/admin/benachrichtigungen/reminder');
  assert.equal(res.status, 200);
  assert.match(res.text, /Wann/);
  assert.match(res.text, /Wer bekommt die Mail/);
  assert.match(res.text, /Was steht drin/);
  assert.match(res.text, /name="zeit_reminder_stunden"[^>]*value="24"/);
  assert.match(res.text, /Gruppe Buchhaltung/);
  assert.match(res.text, /name="betreff"/);
  assert.match(res.text, /name="empfaenger"/);
  assert.match(res.text, /Eine Zeile pro Empfänger: gruppe:buchhaltung, gruppe:admin, person:ID oder E-Mail-Adresse/);
  // Interne Tokens nur in Textarea und Hilfetext.
  assert.doesNotMatch(ohneHilfe(res.text), /gruppe:buchhaltung/);
  // Ereignisliste nach Bereichen, aktives Ereignis markiert.
  assert.match(res.text, /System &amp; Sicherheit/);
  assert.match(listenEintrag(res.text, 'reminder'), /aria-current="page"/);
});

test('POST speichert Stunden, Empfänger und Text; danach Badge „angepasst“', async (t) => {
  const { db, als } = umgebung(t);
  const agent = als();
  const vorher = await agent.get('/admin/benachrichtigungen/reminder');
  assert.doesNotMatch(listenEintrag(vorher.text, 'reminder'), /angepasst/);
  const res = await sende(agent, 'reminder', { ...REMINDER, zeit_reminder_stunden: '12', empfaenger: 'gruppe:admin\r\n person:1 \r\n\r\n', text: 'Neuer Text\r\nZeile 2\r\n' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/admin/benachrichtigungen/reminder?gespeichert=1');
  assert.equal(getConfigValue(db, 'reminder_stunden'), '12');
  assert.equal(getConfigValue(db, 'reminder_empfaenger'), 'gruppe:admin\nperson:1');
  assert.equal(getConfigValue(db, 'mail_vorlage_reminder_text'), 'Neuer Text\nZeile 2');
  const seite = await agent.get(res.headers.location);
  assert.match(seite.text, /Gespeichert\./);
  assert.match(listenEintrag(seite.text, 'reminder'), /angepasst/);
  assert.match(seite.text, /Paula Person/);
  assert.doesNotMatch(listenEintrag(seite.text, 'eskalation'), /angepasst/);
});

test('ungültige Werte → 400 mit Fehler, nichts gespeichert, Eingaben bleiben stehen', async (t) => {
  const { db, als } = umgebung(t);
  const faelle = [
    [{ zeit_reminder_stunden: '-5' }, /positive Ganzzahl/],
    [{ zeit_reminder_stunden: '1.5' }, /positive Ganzzahl/],
    [{ zeit_reminder_stunden: 'abc' }, /positive Ganzzahl/],
    [{ empfaenger: '' }, /mindestens ein Ziel/],
    [{ empfaenger: 'nicht-valide' }, /nicht-valide/],
    [{ empfaenger: 'person:999' }, /unbekannte Person/],
    [{ betreff: '  ' }, /Betreff darf nicht leer sein/],
    [{ text: '' }, /Text darf nicht leer sein/],
  ];
  for (const [felder, fehler] of faelle) {
    const res = await sende(als(), 'reminder', { ...REMINDER, text: 'Entwurf bleibt', ...felder });
    assert.equal(res.status, 400, JSON.stringify(felder));
    assert.match(res.text, fehler, JSON.stringify(felder));
    if (!('text' in felder)) assert.match(res.text, /Entwurf bleibt/);
  }
  assert.equal(getConfigValue(db, 'reminder_stunden'), '24');
  assert.equal(getConfigValue(db, 'reminder_empfaenger'), 'gruppe:buchhaltung');
  assert.equal(getConfigValue(db, 'mail_vorlage_reminder_text'), DEFAULTS.mail_vorlage_reminder_text);
});

test('Zeiten der übrigen Ereignisse: Freigabe 2, Rapporte, Sicherheitsalarm', async (t) => {
  const { db, als } = umgebung(t);
  let res = await sende(als(), 'freigabe2-reminder', { zeit_freigabe2_reminder_stunden: '30', betreff: 'B', text: 'T' });
  assert.equal(res.status, 302);
  assert.equal(getConfigValue(db, 'freigabe2_reminder_stunden'), '30');
  res = await sende(als(), 'freigabe2-eskalation', { zeit_freigabe2_eskalation_stunden: '0', empfaenger: 'gruppe:admin', betreff: 'B', text: 'T' });
  assert.equal(res.status, 400);
  assert.equal(getConfigValue(db, 'freigabe2_eskalation_stunden'), '48');
  res = await sende(als(), 'freigabe2-eskalation', { zeit_freigabe2_eskalation_stunden: '72', empfaenger: 'admin@musterkirche.ch', betreff: 'B', text: 'T' });
  assert.equal(res.status, 302);
  assert.equal(getConfigValue(db, 'freigabe2_eskalation_empfaenger'), 'admin@musterkirche.ch');
  // Rapport-Eskalation: leerer Empfänger erlaubt (dann Admin-Gruppe).
  res = await sende(als(), 'rapport-eskalation', { zeit_rapport_eskalation_stunden: '20', empfaenger: '', betreff: 'B', text: 'T' });
  assert.equal(res.status, 302);
  assert.equal(getConfigValue(db, 'rapport_eskalation_stunden'), '20');
  assert.equal(getConfigValue(db, 'rapport_eskalation_empfaenger'), '');
  res = await sende(als(), 'rapport-reminder', { zeit_rapport_reminder_stunden: 'abc', betreff: 'B', text: 'T' });
  assert.equal(res.status, 400);
  assert.equal(getConfigValue(db, 'rapport_reminder_stunden'), '72');
  // Sicherheitsalarm: ohne Vorlage, nur Wiederholung und Empfänger.
  res = await sende(als(), 'sicherheitsalarm', { zeit_sicherheitsalarm_wiederholung_stunden: '12', empfaenger: 'gruppe:admin\nsicher@example.org' });
  assert.equal(res.status, 302);
  assert.equal(getConfigValue(db, 'sicherheitsalarm_wiederholung_stunden'), '12');
  assert.equal(getConfigValue(db, 'sicherheitsalarm_empfaenger'), 'gruppe:admin\nsicher@example.org');
});

test('Sicherheitsalarm zeigt keinen „Was“-Block; Ereignis ohne Zusatzempfänger kein Empfängerfeld', async (t) => {
  const { als } = umgebung(t);
  const alarm = await als().get('/admin/benachrichtigungen/sicherheitsalarm');
  assert.equal(alarm.status, 200);
  assert.doesNotMatch(alarm.text, /Was steht drin/);
  assert.doesNotMatch(alarm.text, /name="betreff"/);
  assert.doesNotMatch(alarm.text, /Test-Mail an mich/);
  assert.match(alarm.text, /name="empfaenger"/);
  const zuweisung = await als().get('/admin/benachrichtigungen/zuweisung');
  assert.match(zuweisung.text, /Die zuständige Person\./);
  assert.doesNotMatch(zuweisung.text, /name="empfaenger"/);
  assert.match(zuweisung.text, /name="betreff"/);
});

test('Auffälligkeiten: Schwellen prüfen (Anzahl/Tage Ganzzahl, Faktor > 1, CHF ≥ 0)', async (t) => {
  const { db, als } = umgebung(t);
  const gut = {
    zeit_pruefung_betrag_min_rechnungen: '6', zeit_pruefung_betrag_faktor: '2.5', zeit_pruefung_betrag_minimum: '0',
    zeit_pruefung_neuer_kreditor_betrag: '1500.50', zeit_pruefung_gleicher_betrag_tage: '14',
    empfaenger: 'gruppe:admin', betreff: DEFAULTS.mail_vorlage_auffaelligkeiten_warnung_betreff, text: DEFAULTS.mail_vorlage_auffaelligkeiten_warnung_text,
  };
  for (const schlecht of [
    { zeit_pruefung_betrag_min_rechnungen: '0' }, { zeit_pruefung_betrag_faktor: '1' }, { zeit_pruefung_betrag_faktor: '2,5' },
    { zeit_pruefung_betrag_minimum: '-1' }, { zeit_pruefung_neuer_kreditor_betrag: 'viel' }, { zeit_pruefung_gleicher_betrag_tage: '1.5' },
  ]) {
    const res = await sende(als(), 'auffaelligkeiten', { ...gut, ...schlecht });
    assert.equal(res.status, 400, JSON.stringify(schlecht));
  }
  assert.equal(getConfigValue(db, 'pruefung_betrag_faktor'), '3');
  const res = await sende(als(), 'auffaelligkeiten', gut);
  assert.equal(res.status, 302);
  assert.equal(getConfigValue(db, 'pruefung_betrag_min_rechnungen'), '6');
  assert.equal(getConfigValue(db, 'pruefung_betrag_faktor'), '2.5');
  assert.equal(getConfigValue(db, 'pruefung_betrag_minimum'), '0');
  assert.equal(getConfigValue(db, 'pruefung_neuer_kreditor_betrag'), '1500.5');
  assert.equal(getConfigValue(db, 'pruefung_gleicher_betrag_tage'), '14');
  assert.equal(getConfigValue(db, 'iban_abweichung_empfaenger'), 'gruppe:admin');
});

test('zuruecksetzen → Text = Standard, Badge weg', async (t) => {
  const { db, als } = umgebung(t);
  const agent = als();
  setConfigValue(db, 'mail_vorlage_reminder_betreff', 'Eigen');
  setConfigValue(db, 'mail_vorlage_reminder_text', 'Eigener Text');
  assert.match(listenEintrag((await agent.get('/admin/benachrichtigungen/reminder')).text, 'reminder'), /angepasst/);
  const res = await sende(agent, 'reminder', {}, '/zuruecksetzen');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/admin/benachrichtigungen/reminder?zurueckgesetzt=1');
  assert.equal(getConfigValue(db, 'mail_vorlage_reminder_betreff'), DEFAULTS.mail_vorlage_reminder_betreff);
  assert.equal(getConfigValue(db, 'mail_vorlage_reminder_text'), DEFAULTS.mail_vorlage_reminder_text);
  const seite = await agent.get(res.headers.location);
  assert.doesNotMatch(listenEintrag(seite.text, 'reminder'), /angepasst/);
  assert.match(seite.text, /auf den Standard zurückgesetzt/);
  // Ereignis ohne Vorlage: nichts zurückzusetzen.
  assert.equal((await sende(agent, 'sicherheitsalarm', {}, '/zuruecksetzen')).status, 404);
});

test('test-mail → mail_log typ testmail an die Admin-Mail mit gerendertem Beispiel-Betreff, Audit-Eintrag, Hinweis', async (t) => {
  const { db, als, mailer } = umgebung(t);
  setConfigValue(db, 'mail_vorlage_reminder_betreff', 'Erinnerung: %jobDateiname% seit %stunden% h');
  const agent = als();
  const res = await sende(agent, 'reminder', {}, '/test-mail');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/admin/benachrichtigungen/reminder?testmail=versendet');
  const zeile = db.prepare("SELECT * FROM mail_log WHERE typ = 'testmail'").get();
  assert.equal(zeile.empfaenger, 'admin@example.org');
  assert.match(zeile.betreff, /Erinnerung: Rechnung-4711\.pdf seit 24 h/);
  assert.equal(mailer.sent.length, 1);
  const audit = db.prepare("SELECT * FROM audit_ereignisse WHERE objekt = 'benachrichtigung' AND aktion = 'test_mail'").all();
  assert.equal(audit.length, 1);
  assert.equal(audit[0].objekt_id, 'reminder');
  const seite = await agent.get(res.headers.location);
  assert.match(seite.text, /Test-Mail an admin@example\.org verschickt\./);
  assert.equal((await sende(agent, 'sicherheitsalarm', {}, '/test-mail')).status, 404);
});

test('alte Seiten leiten auf die neuen URLs um', async (t) => {
  const { als } = umgebung(t);
  let res = await als().get('/admin/eskalation');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/admin/benachrichtigungen/reminder');
  res = await als().get('/admin/mail-einstellungen');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/admin/benachrichtigungen/zusammenfassung');
});

test('ohne Recht → 403 (Buchhaltung und Manager), ohne Sitzung → 401; nichts gespeichert', async (t) => {
  const { db, als } = umgebung(t);
  for (const person of ['1', '55']) {
    for (const [method, pfad] of [['get', '/admin/benachrichtigungen/reminder'], ['post', '/admin/benachrichtigungen/reminder'], ['post', '/admin/benachrichtigungen/reminder/test-mail']]) {
      const res = await als(person)[method](pfad).type('form').send(REMINDER);
      assert.equal(res.status, 403, `${person} ${method} ${pfad}`);
    }
  }
  const res = await request(createApp({ db, config: testConfig(tmpdir()) })).get('/admin/benachrichtigungen/reminder');
  assert.equal(res.status, 401);
  assert.equal(getConfigValue(db, 'reminder_stunden'), '24');
});

// --- Zusammenfassung & Versandzeit (früher /admin/mail-einstellungen) ---

test('Zusammenfassung: Standard, Wochentag, Uhrzeit und Digest-Vorlage speichern; ungültige Werte → 400', async (t) => {
  const { db, als } = umgebung(t);
  const seite = await als().get('/admin/benachrichtigungen/zusammenfassung');
  assert.match(seite.text, /name="zeit_mail_standard_benachrichtigung"/);
  assert.match(seite.text, /name="zeit_mail_digest_wochentag"/);
  assert.match(seite.text, /%zusammenfassung%/);
  let res = await sende(als(), 'zusammenfassung', { ...ZUSAMMENFASSUNG, zeit_mail_standard_benachrichtigung: 'woechentlich', zeit_mail_digest_wochentag: '5', betreff: 'B8', text: 'T8 %zusammenfassung% %einstellungenLink%' });
  assert.equal(res.status, 302);
  assert.equal(getConfigValue(db, 'mail_standard_benachrichtigung'), 'woechentlich');
  assert.equal(getConfigValue(db, 'mail_digest_wochentag'), '5');
  assert.equal(getConfigValue(db, 'mail_batching_stunde'), '6');
  assert.equal(getConfigValue(db, 'mail_batching_minute'), '30');
  assert.equal(getConfigValue(db, 'mail_vorlage_digest_betreff'), 'B8');
  for (const schlecht of [
    { zeit_mail_standard_benachrichtigung: 'quatsch' }, { zeit_mail_digest_wochentag: '8' }, { zeit_mail_digest_wochentag: '0' },
    { zeit_mail_batching_stunde: '24' }, { zeit_mail_batching_stunde: 'abc' }, { zeit_mail_batching_minute: '60' },
  ]) {
    res = await sende(als(), 'zusammenfassung', { ...ZUSAMMENFASSUNG, ...schlecht });
    assert.equal(res.status, 400, JSON.stringify(schlecht));
  }
  assert.equal(getConfigValue(db, 'mail_standard_benachrichtigung'), 'woechentlich');
  assert.equal(getConfigValue(db, 'mail_digest_wochentag'), '5');
});

test('Zusammenfassung: Hinweis, wenn die Digest-Vorlage %zusammenfassung% oder %einstellungenLink% nicht enthält', async (t) => {
  const { db, als } = umgebung(t);
  const hol = () => als().get('/admin/benachrichtigungen/zusammenfassung');
  assert.doesNotMatch((await hol()).text, /digestVorlageHinweis/);
  setConfigValue(db, 'mail_vorlage_digest_text', 'Eigener Text %eintraege%');
  const res = await hol();
  assert.match(res.text, /digestVorlageHinweis/);
  assert.match(res.text, /nennt nicht %zusammenfassung% und %einstellungenLink%/);
  setConfigValue(db, 'mail_vorlage_digest_text', 'X %zusammenfassung% Y %einstellungenLink%');
  assert.doesNotMatch((await hol()).text, /digestVorlageHinweis/);
});

test('Zusammenfassung: Standard auf sofort stellt Wartendes der nun sofort geltenden Empfänger gleich zu', async (t) => {
  const { db, als, mailer } = umgebung(t);
  upsertPerson(db, { id: '2', vorname: 'A', nachname: 'A', email: 'standard@example.org', gruppen: [], loggedInNow: true });
  upsertPerson(db, { id: '3', vorname: 'B', nachname: 'B', email: 'woche@example.org', gruppen: [], loggedInNow: true });
  setConfigValue(db, 'mail_standard_benachrichtigung', 'woechentlich');
  setzeBenachrichtigung(db, '3', 'woechentlich');
  zuweisungMail(db, 'standard@example.org');
  zuweisungMail(db, 'woche@example.org');
  const res = await sende(als(), 'zusammenfassung', { ...ZUSAMMENFASSUNG, zeit_mail_standard_benachrichtigung: 'sofort', betreff: 'Deine %zusammenfassung% Liste' });
  assert.equal(res.status, 302);
  assert.deepEqual(mailer.sent.map((m) => m.to), ['standard@example.org']);
  assert.match(mailer.sent[0].subject, /wöchentliche/);
  const stati = db.prepare('SELECT status FROM mail_log ORDER BY id').all();
  assert.deepEqual(stati.map((s) => s.status), ['versendet', 'geplant']);
});

function zuweisungMail(db, to) {
  return reiheBenachrichtigungEin(db, { to, typ: 'zuweisung', jobId: null, variablen: { empfaengerName: 'X', jobDateiname: 'a.pdf', grund: 'G', link: 'L' } });
}

test('Zusammenfassung: „Jetzt ausführen“ startet den Digest und nennt zurückgehaltene wöchentliche Empfänger', async (t) => {
  const { db, als } = umgebung(t);
  upsertPerson(db, { id: '4', vorname: 'W', nachname: 'X', email: 'w@example.org', gruppen: [] });
  setzeBenachrichtigung(db, '4', 'woechentlich');
  // Wochentag = morgen (Zürcher Zeit), damit heute garantiert nicht fällig ist
  const morgen = zuercherWochentag(Date.now() + 24 * 3600 * 1000);
  setConfigValue(db, 'mail_digest_wochentag', String(morgen));
  zuweisungMail(db, 'w@example.org');
  const agent = als();
  const res = await sende(agent, 'zusammenfassung', {}, '/jetzt-ausfuehren');
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /^\/admin\/benachrichtigungen\/zusammenfassung\?getriggert=1&zurueckgestellt=1$/);
  const seite = await agent.get(res.headers.location);
  const namen = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];
  assert.match(seite.text, new RegExp(`1 wöchentliche[^<]* bis ${namen[morgen - 1]} zurückgehalten`));
  assert.match(seite.text, /Erfolgreich ausgeführt/);
});

// --- Audit-Prüfnummer: nur E-Mail-Adressen, Meldungen an die Revision ---

test('Audit-Prüfnummer: Empfängerwechsel meldet alte und neue Adresse, unverändert keine Mail', async (t) => {
  const { db, als, mailer } = umgebung(t);
  setConfigValue(db, 'audit_revision_empfaenger', 'alt@example.org');
  let seite = await als().get('/admin/benachrichtigungen/audit-pruefnummer');
  assert.match(seite.text, /<textarea[^>]*name="empfaenger"[^>]*>alt@example\.org</);
  let res = await sende(als(), 'audit-pruefnummer', { ...AUDIT, empfaenger: ' neu@example.org \r\nneu@example.org, zwei@example.org' });
  assert.equal(res.status, 302);
  assert.equal(getConfigValue(db, 'audit_revision_empfaenger'), 'neu@example.org, zwei@example.org');
  const wechsel = mailer.sent.filter((m) => /Empfänger der Audit-Prüfnummer/.test(m.subject));
  assert.deepEqual(wechsel.map((m) => m.to).sort(), ['alt@example.org', 'neu@example.org', 'zwei@example.org']);
  assert.match(wechsel[0].text, /Admina Portal/);
  const audit = db.prepare("SELECT * FROM audit_ereignisse WHERE objekt = 'admin_config' AND objekt_id = 'audit_revision_empfaenger'").all();
  assert.ok(audit.length >= 1);
  mailer.sent.length = 0;
  res = await sende(als(), 'audit-pruefnummer', { ...AUDIT, empfaenger: 'neu@example.org\nzwei@example.org' });
  assert.equal(res.status, 302);
  assert.equal(mailer.sent.length, 0);
  seite = await als().get('/admin/benachrichtigungen/audit-pruefnummer');
  assert.match(seite.text, /<textarea[^>]*name="empfaenger"[^>]*>neu@example\.org\nzwei@example\.org</);
});

test('Audit-Prüfnummer: nur E-Mail-Adressen erlaubt; Gruppen, Personen und kaputte Adressen → 400', async (t) => {
  const { db, als } = umgebung(t);
  for (const empfaenger of ['gruppe:admin', 'person:1', 'gut@example.org\nkaputt']) {
    const res = await sende(als(), 'audit-pruefnummer', { ...AUDIT, empfaenger });
    assert.equal(res.status, 400, empfaenger);
    assert.match(res.text, /Ungültige Mailadresse/);
  }
  assert.equal(getConfigValue(db, 'audit_revision_empfaenger'), '');
  const seite = await als().get('/admin/benachrichtigungen/audit-pruefnummer');
  assert.match(seite.text, /nur E-Mail-Adressen/);
});

test('Audit-Prüfnummer: Adresse eines Superadmins → gespeichert, Seite warnt', async (t) => {
  const { db, als } = umgebung(t);
  const res = await sende(als(), 'audit-pruefnummer', { ...AUDIT, empfaenger: 'Admin@Example.org' });
  assert.equal(res.status, 302);
  assert.equal(getConfigValue(db, 'audit_revision_empfaenger'), 'Admin@Example.org');
  const seite = await als().get('/admin/benachrichtigungen/audit-pruefnummer');
  assert.match(seite.text, /gehört einer Person mit Admin-Rechten/);
});

test('Audit-Prüfnummer: Vorlagenänderung meldet an die Revision (ohne Vorlageninhalt); ohne Änderung keine Mail', async (t) => {
  const { db, als, mailer } = umgebung(t);
  setConfigValue(db, 'audit_revision_empfaenger', 'revision@example.org');
  const geaendert = { ...AUDIT, empfaenger: 'revision@example.org', betreff: 'B16', text: 'T16' };
  let res = await sende(als(), 'audit-pruefnummer', geaendert);
  assert.equal(res.status, 302);
  assert.equal(mailer.sent.length, 1);
  assert.equal(mailer.sent[0].to, 'revision@example.org');
  assert.match(mailer.sent[0].text, /Betreff der Prüfnummer-Mail wurde geändert/);
  assert.match(mailer.sent[0].text, /Text der Prüfnummer-Mail wurde geändert/);
  assert.doesNotMatch(mailer.sent[0].text, /B16|T16/);
  mailer.sent.length = 0;
  res = await sende(als(), 'audit-pruefnummer', geaendert);
  assert.equal(res.status, 302);
  assert.equal(mailer.sent.length, 0);
  // Zurücksetzen ändert die Vorlage ebenfalls → Meldung.
  res = await sende(als(), 'audit-pruefnummer', {}, '/zuruecksetzen');
  assert.equal(res.status, 302);
  assert.equal(mailer.sent.length, 1);
  assert.match(mailer.sent[0].text, /Text der Prüfnummer-Mail wurde geändert/);
});

test('Sync-Fehler: Empfänger werden hier gespeichert und geprüft', async (t) => {
  const { db, als } = umgebung(t);
  let res = await sende(als(), 'sync-fehler', { empfaenger: 'nicht-valide', betreff: 'B', text: 'T' });
  assert.equal(res.status, 400);
  res = await sende(als(), 'sync-fehler', { empfaenger: 'gruppe:admin\nit@example.org', betreff: 'B', text: 'T' });
  assert.equal(res.status, 302);
  assert.equal(getConfigValue(db, 'sync_fehler_empfaenger'), 'gruppe:admin\nit@example.org');
});

test('Audit-Prüfnummer: neue Adresse und geänderter Betreff im selben Speichern → Änderungsmail an alte und neue Adresse', async (t) => {
  const { db, als, mailer } = umgebung(t);
  setConfigValue(db, 'audit_revision_empfaenger', 'alt@example.org');
  const res = await sende(als(), 'audit-pruefnummer', { ...AUDIT, empfaenger: 'neu@example.org', betreff: 'Neuer Betreff' });
  assert.equal(res.status, 302);
  const aenderung = mailer.sent.filter((m) => /Einstellungen des Audit-Nachweises/.test(m.subject));
  assert.deepEqual(aenderung.map((m) => m.to).sort(), ['alt@example.org', 'neu@example.org']);
  assert.match(aenderung[0].text, /Betreff der Prüfnummer-Mail wurde geändert/);
});

test('Rechte: jetzt-ausfuehren und zuruecksetzen → 403 ohne Recht; POSTs ohne Sitzung → 401, nichts geändert', async (t) => {
  const { db, als } = umgebung(t);
  setConfigValue(db, 'mail_vorlage_reminder_text', 'Eigen');
  for (const person of ['1', '55']) {
    for (const pfad of ['/admin/benachrichtigungen/zusammenfassung/jetzt-ausfuehren', '/admin/benachrichtigungen/reminder/zuruecksetzen']) {
      const res = await als(person).post(pfad).type('form').send({});
      assert.equal(res.status, 403, `${person} ${pfad}`);
    }
  }
  const ohneSitzung = request(createApp({ db, config: testConfig(tmpdir()) }));
  for (const pfad of ['/admin/benachrichtigungen/zusammenfassung/jetzt-ausfuehren', '/admin/benachrichtigungen/reminder', '/admin/benachrichtigungen/reminder/zuruecksetzen']) {
    const res = await ohneSitzung.post(pfad).type('form').send({ ...REMINDER, zeit_reminder_stunden: '5' });
    assert.equal(res.status, 401, pfad);
  }
  assert.equal(getConfigValue(db, 'reminder_stunden'), '24');
  assert.equal(getConfigValue(db, 'mail_vorlage_reminder_text'), 'Eigen');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM cron_log WHERE job = 'mail-digest'").get().n, 0);
});

test('Auffälligkeiten: ungültiger Zusatzempfänger → 400; Sicherheitsalarm: leere Liste → 400', async (t) => {
  const { db, als } = umgebung(t);
  let res = await sende(als(), 'auffaelligkeiten', { empfaenger: 'nicht-valide' });
  assert.equal(res.status, 400);
  assert.match(res.text, /nicht-valide/);
  assert.equal(getConfigValue(db, 'iban_abweichung_empfaenger'), DEFAULTS.iban_abweichung_empfaenger);
  res = await sende(als(), 'sicherheitsalarm', { zeit_sicherheitsalarm_wiederholung_stunden: '24', empfaenger: '' });
  assert.equal(res.status, 400);
  assert.match(res.text, /mindestens ein Ziel/);
  assert.equal(getConfigValue(db, 'sicherheitsalarm_empfaenger'), 'gruppe:admin');
});

test('Vorschau: Beschriftung je nach gespeichertem/eingegebenem Text; %debitorName% wird befüllt; Hinweis zur Test-Mail', async (t) => {
  const { db, als } = umgebung(t);
  setConfigValue(db, 'mail_vorlage_duplikat_warnung_betreff', 'Doppelt bei %debitorName%');
  const seite = await als().get('/admin/benachrichtigungen/duplikat-warnung');
  assert.match(seite.text, /\(gespeicherter Text mit Beispieldaten\)/);
  assert.match(seite.text, /Doppelt bei Muster AG/);
  assert.match(seite.text, /Die Test-Mail verwendet den gespeicherten Text\./);
  const res = await sende(als(), 'duplikat-warnung', { betreff: 'Entwurf %kreditorName%', text: '' });
  assert.equal(res.status, 400);
  assert.match(res.text, /\(eingegebener, noch nicht gespeicherter Text mit Beispieldaten\)/);
  assert.match(res.text, /Entwurf Muster AG/);
});

test('Zusatzempfänger: unbekannte Person bekommt Badge „unbekannt“, inaktive „inaktiv“', async (t) => {
  const { db, als } = umgebung(t);
  upsertPerson(db, { id: '7', vorname: 'Ina', nachname: 'Weg', email: 'weg@example.org', gruppen: [] });
  db.prepare("UPDATE personen SET aktiv = 0 WHERE churchtools_person_id = '7'").run();
  setConfigValue(db, 'reminder_empfaenger', 'person:7\nperson:404');
  const seite = await als().get('/admin/benachrichtigungen/reminder');
  assert.match(seite.text, /Ina Weg\s*<span class="badge text-bg-secondary ms-1">inaktiv<\/span>/);
  assert.match(seite.text, /Person 404\s*<span class="badge text-bg-warning ms-1">unbekannt<\/span>/);
});

test('Sync-Seite verweist für die Empfänger auf Benachrichtigungen', async (t) => {
  const { als } = umgebung(t);
  const seite = await als().get('/admin/sync');
  assert.match(seite.text, /Wer bei einem Sync-Fehler eine Mail bekommt, legt eine Superadmin-Person unter „Benachrichtigungen“ fest\./);
  assert.match(seite.text, /href="\/admin\/benachrichtigungen\/sync-fehler">Empfänger einstellen → Benachrichtigungen</);
  assert.doesNotMatch(seite.text, /name="syncFehlerEmpfaenger"/);
});

// Komfort im Browser (public/js/benachrichtigungen.js): Skript, Datenelement und Variablen-Knöpfe.
const datenAus = (text) => {
  const m = text.match(/<script type="application\/json" id="benachrichtigungDaten" nonce="[^"]*">([\s\S]*?)<\/script>/);
  if (!m) throw new Error('kein Datenelement benachrichtigungDaten');
  return JSON.parse(m[1]);
};

test('Komfort: Skript, Datenelement mit aktiven Personen (nur id + Name), Gruppen, Beispielen und Variablen-Knöpfen', async (t) => {
  const { db, als } = umgebung(t);
  upsertPerson(db, { id: '7', vorname: 'Ina', nachname: 'Weg', email: 'weg@example.org', gruppen: [] });
  db.prepare("UPDATE personen SET aktiv = 0 WHERE churchtools_person_id = '7'").run();
  upsertPerson(db, { id: '8', vorname: 'Ohne', nachname: 'Mail', email: '', gruppen: [] });
  upsertPerson(db, { id: '9', vorname: '</script><b>', nachname: 'X', email: 'x@example.org', gruppen: [] });
  setConfigValue(db, 'reminder_empfaenger', 'person:7\ngruppe:admin');
  const zuweisung = await als().get('/admin/benachrichtigungen/zuweisung');
  assert.equal(zuweisung.status, 200);
  assert.match(zuweisung.text, /<script src="\/js\/benachrichtigungen\.js\?v=[^"]*" defer><\/script>/);
  assert.match(zuweisung.text, /<button type="button" class="[^"]*\bvar\b[^"]*" data-var="empfaengerName">Name\b/);
  assert.equal(datenAus(zuweisung.text).beispiele.empfaengerName, 'Anna Muster');
  assert.deepEqual(datenAus(zuweisung.text).personen, [], 'ohne Zusatzempfänger keine Personenliste');

  const seite = await als().get('/admin/benachrichtigungen/reminder');
  const daten = datenAus(seite.text);
  assert.equal(daten.nurEmail, false);
  assert.deepEqual(daten.personen.map((p) => Object.keys(p).sort()), daten.personen.map(() => ['id', 'name']));
  const ids = daten.personen.map((p) => p.id);
  assert.ok(ids.includes('1') && ids.includes('9'));
  assert.ok(!ids.includes('7'), 'inaktive Person nicht im Picker');
  assert.ok(!ids.includes('8'), 'Person ohne Mail nicht im Picker');
  assert.equal(daten.personen.find((p) => p.id === '1').name, 'Paula Person');
  assert.doesNotMatch(seite.text, /<\/script><b>/, 'Namen im JSON dürfen das Skript-Element nicht beenden');
  assert.deepEqual(daten.gruppen, [{ wert: 'gruppe:admin', label: 'Gruppe Admin' }, { wert: 'gruppe:buchhaltung', label: 'Gruppe Buchhaltung' }]);
  assert.equal(daten.beispiele.jobDateiname, 'Rechnung-4711.pdf');
  assert.equal(daten.beispiele.portalName, 'Freigabeportal');
  assert.deepEqual(daten.anzeige, [{ wert: 'person:7', label: 'Ina Weg', hinweis: 'inaktiv' }, { wert: 'gruppe:admin', label: 'Gruppe Admin', hinweis: null }]);
});

test('Komfort: Audit-Prüfnummer bietet nur E-Mail-Adressen an (keine Personen, keine Gruppen)', async (t) => {
  const { als } = umgebung(t);
  const daten = datenAus((await als().get('/admin/benachrichtigungen/audit-pruefnummer')).text);
  assert.equal(daten.nurEmail, true);
  assert.deepEqual(daten.personen, []);
  assert.deepEqual(daten.gruppen, []);
});

test('Komfort: nach Fehler ist das Formular als ungespeichert markiert (Hinweis zur Test-Mail)', async (t) => {
  const { als } = umgebung(t);
  const gut = await als().get('/admin/benachrichtigungen/reminder');
  assert.doesNotMatch(gut.text, /id="ereignisForm" data-ungespeichert/);
  const res = await sende(als(), 'reminder', { ...REMINDER, betreff: '' });
  assert.equal(res.status, 400);
  assert.match(res.text, /id="ereignisForm" data-ungespeichert/);
});
