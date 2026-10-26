import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { openDatabase } from '../../../src/db/index.js';
import { seedDefaults, getConfigValue, setConfigValue } from '../../../src/db/adminConfigRepo.js';
import { upsertPerson } from '../../../src/db/personenRepo.js';
import { setzeBenachrichtigung, zuercherWochentag } from '../../../src/services/benachrichtigung.js';
import { reiheBenachrichtigungEin } from '../../../src/services/notify.js';
import { loadCurrentPerson, requireRole } from '../../../src/middleware/roles.js';
import { loadNavFlags } from '../../../src/middleware/nav.js';
import { createMailEinstellungenRouter } from '../../../src/routes/admin/mailEinstellungen.js';

function buildTestApp(db) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', new URL('../../../views', import.meta.url).pathname);
  app.use((req, res, next) => {
    res.locals.branding = { primaryColor: '#000', secondaryColor: '#fff', hasLogo: false, themeAttr: null };
    next();
  });
  app.use(express.urlencoded({ extended: false }));
  app.use((req, res, next) => {
    req.session = { personId: req.headers['x-test-person-id'] };
    next();
  });
  const config = { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20', groupIdManager: '30' }, publicBaseUrl: 'http://portal.example.org' };
  app.use(loadCurrentPerson(db));
  app.use(loadNavFlags(db, config));
  const mailer = { sent: [], async sendMail(mail) { this.sent.push(mail); } };
  app.use('/admin/mail-einstellungen', requireRole(config, 'superadmin'), createMailEinstellungenRouter({ db, config, mailer }));
  app.mailer = mailer;
  return app;
}

function seedAdmin(db) {
  upsertPerson(db, { id: '99', vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'], loggedInNow: true });
}

const MAIL_EINSTELLUNGEN_ROUTES = [
  { method: 'get', path: '/admin/mail-einstellungen' },
  { method: 'post', path: '/admin/mail-einstellungen' },
];

const VALID_BODY = {
  zuweisungBetreff: 'B1', zuweisungText: 'T1',
  reminderBetreff: 'B2', reminderText: 'T2',
  eskalationBetreff: 'B3', eskalationText: 'T3',
  ablehnungBetreff: 'B4', ablehnungText: 'T4',
  syncFehlerBetreff: 'B5', syncFehlerText: 'T5',
  ibanWarnungBetreff: 'B6', ibanWarnungText: 'T6',
  rechnungsnummerWarnungBetreff: 'B7', rechnungsnummerWarnungText: 'T7',
  digestBetreff: 'B8', digestText: 'T8',
  freigabe2ReminderBetreff: 'B9', freigabe2ReminderText: 'T9',
  freigabe2EskalationBetreff: 'B10', freigabe2EskalationText: 'T10',
  kkAbrechnungZugewiesenBetreff: 'B11', kkAbrechnungZugewiesenText: 'T11',
  kkBelegErinnerungBetreff: 'B12', kkBelegErinnerungText: 'T12',
  kkBelegEingegangenBetreff: 'B13', kkBelegEingegangenText: 'T13',
  adminUmzuweisungBetreff: 'B14', adminUmzuweisungText: 'T14',
  duplikatWarnungBetreff: 'B15', duplikatWarnungText: 'T15',
  auditPruefnummerBetreff: 'B16', auditPruefnummerText: 'T16',
  neuesGeraetBetreff: 'B17', neuesGeraetText: 'T17',
  fehlermeldungBetreff: 'B18', fehlermeldungText: 'T18',
  kommentarBetreff: 'B19', kommentarText: 'T19',
  standardBenachrichtigung: 'taeglich',
  digestWochentag: '3',
  batchingStunde: '6',
  batchingMinute: '30',
};

test('every mail-einstellungen route returns 401 without any session, and config is untouched', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  const app = buildTestApp(db);
  for (const { method, path } of MAIL_EINSTELLUNGEN_ROUTES) {
    const res = await request(app)[method](path).type('form').send(VALID_BODY);
    assert.equal(res.status, 401, `${method.toUpperCase()} ${path} should be 401 without a session`);
  }
  assert.equal(getConfigValue(db, 'mail_batching_aktiv'), '0');
  db.close();
});

test('every mail-einstellungen route returns 403 for a logged-in non-superadmin (Manager)', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  upsertPerson(db, { id: '55', vorname: 'Mana', nachname: 'Ger', email: 'manager@example.org', gruppen: ['30'], loggedInNow: true });
  const app = buildTestApp(db);
  for (const { method, path } of MAIL_EINSTELLUNGEN_ROUTES) {
    const res = await request(app)[method](path).set('x-test-person-id', '55').type('form').send(VALID_BODY);
    assert.equal(res.status, 403, `${method.toUpperCase()} ${path} should be 403 for a non-superadmin`);
  }
  db.close();
});

test('GET /admin/mail-einstellungen shows the current templates and batching config', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  const app = buildTestApp(db);
  const res = await request(app).get('/admin/mail-einstellungen').set('x-test-person-id', '99');
  assert.equal(res.status, 200);
  assert.match(res.text, /Freigabeportal: Neue Rechnung zur Bearbeitung/);
  assert.doesNotMatch(res.text, /name="batchingAktiv"/);
  assert.match(res.text, /name="standardBenachrichtigung"/);
  assert.match(res.text, /name="digestWochentag"/);
  assert.match(res.text, /%zusammenfassung%/);
  assert.match(res.text, /%einstellungenLink%/);
});

test('POST /admin/mail-einstellungen saves all 8 templates and the batching config', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  const app = buildTestApp(db);
  const res = await request(app).post('/admin/mail-einstellungen').set('x-test-person-id', '99').type('form').send(VALID_BODY);
  assert.equal(res.status, 302);
  assert.equal(getConfigValue(db, 'mail_vorlage_zuweisung_betreff'), 'B1');
  assert.equal(getConfigValue(db, 'mail_vorlage_digest_text'), 'T8');
  assert.equal(getConfigValue(db, 'mail_batching_aktiv'), '0', 'alter Schlüssel wird nicht mehr geschrieben');
  assert.equal(getConfigValue(db, 'mail_standard_benachrichtigung'), 'taeglich');
  assert.equal(getConfigValue(db, 'mail_digest_wochentag'), '3');
  assert.equal(getConfigValue(db, 'mail_batching_stunde'), '6');
  assert.equal(getConfigValue(db, 'mail_batching_minute'), '30');
  db.close();
});

test('POST /admin/mail-einstellungen persists the freigabe2 template fields', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  const app = buildTestApp(db);
  const res = await request(app).post('/admin/mail-einstellungen').set('x-test-person-id', '99').type('form').send(VALID_BODY);
  assert.equal(res.status, 302);
  assert.equal(getConfigValue(db, 'mail_vorlage_freigabe2_reminder_betreff'), 'B9');
  assert.equal(getConfigValue(db, 'mail_vorlage_freigabe2_reminder_text'), 'T9');
  assert.equal(getConfigValue(db, 'mail_vorlage_freigabe2_eskalation_betreff'), 'B10');
  assert.equal(getConfigValue(db, 'mail_vorlage_freigabe2_eskalation_text'), 'T10');
  assert.equal(getConfigValue(db, 'mail_vorlage_kk_beleg_erinnerung_betreff'), 'B12');
  assert.equal(getConfigValue(db, 'mail_vorlage_kk_beleg_erinnerung_text'), 'T12');
  assert.equal(getConfigValue(db, 'mail_vorlage_kk_beleg_eingegangen_betreff'), 'B13');
  assert.equal(getConfigValue(db, 'mail_vorlage_kk_beleg_eingegangen_text'), 'T13');
  assert.equal(getConfigValue(db, 'mail_vorlage_kommentar_betreff'), 'B19');
  assert.equal(getConfigValue(db, 'mail_vorlage_kommentar_text'), 'T19');
  db.close();
});

test('POST /admin/mail-einstellungen rejects an empty freigabe2ReminderBetreff', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  const app = buildTestApp(db);
  const res = await request(app)
    .post('/admin/mail-einstellungen')
    .set('x-test-person-id', '99')
    .type('form')
    .send({ ...VALID_BODY, freigabe2ReminderBetreff: '' });
  assert.equal(res.status, 400);
  db.close();
});

test('POST /admin/mail-einstellungen speichert wöchentlich als Standard, ungültige Werte → 400', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  const app = buildTestApp(db);
  const post = (body) => request(app).post('/admin/mail-einstellungen').set('x-test-person-id', '99').type('form').send(body);
  let res = await post({ ...VALID_BODY, standardBenachrichtigung: 'woechentlich', digestWochentag: '5' });
  assert.equal(res.status, 302);
  assert.equal(getConfigValue(db, 'mail_standard_benachrichtigung'), 'woechentlich');
  assert.equal(getConfigValue(db, 'mail_digest_wochentag'), '5');
  res = await post({ ...VALID_BODY, standardBenachrichtigung: 'sofort' });
  assert.equal(getConfigValue(db, 'mail_standard_benachrichtigung'), 'sofort');
  res = await post({ ...VALID_BODY, standardBenachrichtigung: 'quatsch' });
  assert.equal(res.status, 400);
  res = await post({ ...VALID_BODY, digestWochentag: '8' });
  assert.equal(res.status, 400);
  assert.equal(getConfigValue(db, 'mail_standard_benachrichtigung'), 'sofort');
  db.close();
});

test('POST /admin/mail-einstellungen rejects a non-integer batchingStunde', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  const app = buildTestApp(db);
  const res = await request(app).post('/admin/mail-einstellungen').set('x-test-person-id', '99').type('form').send({ ...VALID_BODY, batchingStunde: 'abc' });
  assert.equal(res.status, 400);
  db.close();
});

test('POST /admin/mail-einstellungen/jetzt-ausfuehren triggers runMailDigestJob and redirects back', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  const app = buildTestApp(db);
  const res = await request(app).post('/admin/mail-einstellungen/jetzt-ausfuehren').set('x-test-person-id', '99');
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /^\/admin\/mail-einstellungen\?getriggert=1/);
  db.close();
});

test('jetzt ausführen nennt die bis zum Wochentag zurückgehaltenen wöchentlichen Empfänger', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  upsertPerson(db, { id: '1', vorname: 'W', nachname: 'X', email: 'w@example.org', gruppen: [] });
  setzeBenachrichtigung(db, '1', 'woechentlich');
  // Wochentag = morgen (Zürcher Zeit), damit heute garantiert nicht fällig ist
  const morgen = zuercherWochentag(Date.now() + 24 * 3600 * 1000);
  setConfigValue(db, 'mail_digest_wochentag', String(morgen));
  reiheBenachrichtigungEin(db, { to: 'w@example.org', typ: 'zuweisung', jobId: null, variablen: { empfaengerName: 'X', jobDateiname: 'a.pdf', grund: 'G', link: 'L' } });
  const app = buildTestApp(db);
  const res = await request(app).post('/admin/mail-einstellungen/jetzt-ausfuehren').set('x-test-person-id', '99');
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /zurueckgestellt=1/);
  const seite = await request(app).get(res.headers.location).set('x-test-person-id', '99');
  const namen = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];
  assert.match(seite.text, new RegExp(`1 wöchentliche[^<]* bis ${namen[morgen - 1]} zurückgehalten`));
  db.close();
});

test('Änderung der Prüfnummer-Mail-Vorlage meldet an die Revision (ohne Vorlageninhalt); ohne Änderung keine Mail', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  setConfigValue(db, 'audit_revision_empfaenger', 'revision@example.org');
  const app = buildTestApp(db);
  const post = (body) => request(app).post('/admin/mail-einstellungen').set('x-test-person-id', '99').type('form').send(body);
  let res = await post(VALID_BODY);
  assert.equal(res.status, 302);
  assert.equal(app.mailer.sent.length, 1);
  assert.equal(app.mailer.sent[0].to, 'revision@example.org');
  assert.match(app.mailer.sent[0].text, /Betreff der Prüfnummer-Mail wurde geändert/);
  assert.match(app.mailer.sent[0].text, /Text der Prüfnummer-Mail wurde geändert/);
  assert.doesNotMatch(app.mailer.sent[0].text, /B16|T16/);
  app.mailer.sent.length = 0;
  res = await post(VALID_BODY);
  assert.equal(res.status, 302);
  assert.equal(app.mailer.sent.length, 0);
  res = await post({ ...VALID_BODY, zuweisungBetreff: 'anderer Betreff' });
  assert.equal(res.status, 302);
  assert.equal(app.mailer.sent.length, 0);
  db.close();
});

// --- Abschlussprüfung ---

test('F1: Vorlagen werden mit LF gespeichert (CRLF aus der Textarea normalisiert)', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  const res = await request(buildTestApp(db)).post('/admin/mail-einstellungen').set('x-test-person-id', '99').type('form')
    .send({ ...VALID_BODY, digestText: 'Zeile 1\r\n\r\nZeile 2\r\n', zuweisungText: 'a\rb' });
  assert.equal(res.status, 302);
  assert.equal(getConfigValue(db, 'mail_vorlage_digest_text'), 'Zeile 1\n\nZeile 2');
  assert.equal(getConfigValue(db, 'mail_vorlage_zuweisung_text'), 'a\nb');
  db.close();
});

test('F2: Hinweis, wenn die Digest-Vorlage %zusammenfassung% oder %einstellungenLink% nicht enthält', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  const app = buildTestApp(db);
  const hol = () => request(app).get('/admin/mail-einstellungen').set('x-test-person-id', '99');
  assert.doesNotMatch((await hol()).text, /digestVorlageHinweis/);
  setConfigValue(db, 'mail_vorlage_digest_text', 'Eigener Text %eintraege%');
  const res = await hol();
  assert.match(res.text, /digestVorlageHinweis/);
  assert.match(res.text, /nennt nicht %zusammenfassung% und %einstellungenLink%/);
  setConfigValue(db, 'mail_vorlage_digest_text', 'X %zusammenfassung% Y %einstellungenLink%');
  assert.doesNotMatch((await hol()).text, /digestVorlageHinweis/);
  db.close();
});

test('F5: Standard auf sofort stellt Wartendes der nun sofort geltenden Empfänger gleich zu', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  upsertPerson(db, { id: '1', vorname: 'A', nachname: 'A', email: 'standard@example.org', gruppen: [], loggedInNow: true });
  upsertPerson(db, { id: '2', vorname: 'B', nachname: 'B', email: 'woche@example.org', gruppen: [], loggedInNow: true });
  setConfigValue(db, 'mail_standard_benachrichtigung', 'woechentlich');
  setzeBenachrichtigung(db, '2', 'woechentlich');
  zuweisungMail(db, 'standard@example.org');
  zuweisungMail(db, 'woche@example.org');
  const app = buildTestApp(db);
  const res = await request(app).post('/admin/mail-einstellungen').set('x-test-person-id', '99').type('form')
    .send({ ...VALID_BODY, standardBenachrichtigung: 'sofort', digestBetreff: 'Deine %zusammenfassung% Liste' });
  assert.equal(res.status, 302);
  assert.deepEqual(app.mailer.sent.map((m) => m.to), ['standard@example.org']);
  assert.match(app.mailer.sent[0].subject, /wöchentliche/);
  const stati = db.prepare('SELECT empfaenger, status FROM mail_log ORDER BY id').all();
  assert.deepEqual(stati.map((s) => s.status), ['versendet', 'geplant']);
  db.close();
});

function zuweisungMail(db, to) {
  return reiheBenachrichtigungEin(db, { to, typ: 'zuweisung', jobId: null, variablen: { empfaengerName: 'X', jobDateiname: 'a.pdf', grund: 'G', link: 'L' } });
}
