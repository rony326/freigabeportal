import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { openDatabase } from '../../../src/db/index.js';
import { seedDefaults, getConfigValue, setConfigValue } from '../../../src/db/adminConfigRepo.js';
import { upsertPerson } from '../../../src/db/personenRepo.js';
import { loadCurrentPerson, requireRole } from '../../../src/middleware/roles.js';
import { loadNavFlags } from '../../../src/middleware/nav.js';
import { createZeitstempelAdminRouter } from '../../../src/routes/admin/zeitstempel.js';

function buildTestApp(db, mails = []) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', new URL('../../../views', import.meta.url).pathname);
  app.use((req, res, next) => {
    res.locals.branding = { primaryColor: '#000', secondaryColor: '#fff', hasLogo: false, themeAttr: null, seitenTitel: 'Freigabeportal' };
    next();
  });
  app.use(express.urlencoded({ extended: false }));
  app.use((req, res, next) => {
    req.session = { personId: req.headers['x-test-person-id'] };
    next();
  });
  const config = { publicBaseUrl: 'https://portal.example.org', churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20', groupIdManager: '30' } };
  const mailer = { async sendMail(mail) { mails.push(mail); } };
  app.use(loadCurrentPerson(db));
  app.use(loadNavFlags(db, config));
  app.use('/admin/zeitstempel', requireRole(config, 'superadmin'), createZeitstempelAdminRouter({ db, config, mailer }));
  return app;
}

function seedAdmin(db) {
  upsertPerson(db, { id: '99', vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'], loggedInNow: true });
}

const ZEITSTEMPEL_ROUTES = [
  { method: 'get', path: '/admin/zeitstempel' },
  { method: 'post', path: '/admin/zeitstempel' },
  { method: 'post', path: '/admin/zeitstempel/audit-pruefnummer-senden' },
];

test('every Zeitstempel route returns 401 without any session, and config is untouched', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  const app = buildTestApp(db);
  for (const { method, path } of ZEITSTEMPEL_ROUTES) {
    const res = await request(app)[method](path).type('form').send({ tsaUrl: 'https://tsa.example.org/tsr' });
    assert.equal(res.status, 401, `${method.toUpperCase()} ${path} should be 401 without a session`);
  }
  assert.equal(getConfigValue(db, 'zeitstempel_tsa_url'), '');
  db.close();
});

test('every Zeitstempel route returns 403 for a logged-in non-admin (buchhaltung only)', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  upsertPerson(db, { id: '77', vorname: 'Nur', nachname: 'Buchhaltung', email: 'b@example.org', gruppen: ['10'], loggedInNow: true });
  const app = buildTestApp(db);
  for (const { method, path } of ZEITSTEMPEL_ROUTES) {
    const res = await request(app)[method](path).set('x-test-person-id', '77').type('form').send({ tsaUrl: 'https://tsa.example.org/tsr' });
    assert.equal(res.status, 403, `${method.toUpperCase()} ${path} should be 403 for a non-admin`);
  }
  db.close();
});

test('GET /admin/zeitstempel returns 403 for a Manager (hard-locked to superadmin only)', async () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '55', vorname: 'Mana', nachname: 'Ger', email: 'manager@example.org', gruppen: ['30'], loggedInNow: true });
  const app = buildTestApp(db);
  const res = await request(app).get('/admin/zeitstempel').set('x-test-person-id', '55');
  assert.equal(res.status, 403);
  db.close();
});

test('GET /admin/zeitstempel shows the configured TSA URL, username and Warnschwelle pre-filled, never the password', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  const { setConfigValue } = await import('../../../src/db/adminConfigRepo.js');
  setConfigValue(db, 'zeitstempel_tsa_url', 'https://freetsa.org/tsr');
  setConfigValue(db, 'zeitstempel_tsa_user', 'meinuser');
  setConfigValue(db, 'zeitstempel_tsa_passwort', 'geheimnis123');
  setConfigValue(db, 'zeitstempel_warnung_ab_stunden', '3');
  seedAdmin(db);
  const app = buildTestApp(db);
  const res = await request(app).get('/admin/zeitstempel').set('x-test-person-id', '99');
  assert.equal(res.status, 200);
  assert.match(res.text, /id="tsaUrl"[^>]*value="https:\/\/freetsa\.org\/tsr"/);
  assert.match(res.text, /id="tsaUser"[^>]*value="meinuser"/);
  assert.match(res.text, /id="warnungAbStunden"[^>]*value="3"/);
  assert.doesNotMatch(res.text, /geheimnis123/, 'the stored password must never be echoed back into the form');
  db.close();
});

test('POST /admin/zeitstempel persists a valid TSA URL, username, password and Warnschwelle', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  const app = buildTestApp(db);
  const res = await request(app)
    .post('/admin/zeitstempel')
    .set('x-test-person-id', '99')
    .type('form')
    .send({ tsaUrl: 'https://freetsa.org/tsr', tsaUser: 'meinuser', tsaPasswort: 'geheimnis123', warnungAbStunden: '4' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/admin/zeitstempel?gespeichert=1');
  assert.equal(getConfigValue(db, 'zeitstempel_tsa_url'), 'https://freetsa.org/tsr');
  assert.equal(getConfigValue(db, 'zeitstempel_tsa_user'), 'meinuser');
  assert.equal(getConfigValue(db, 'zeitstempel_tsa_passwort'), 'geheimnis123');
  assert.equal(getConfigValue(db, 'zeitstempel_warnung_ab_stunden'), '4');
  db.close();
});

test('POST /admin/zeitstempel with an empty TSA URL disables the feature (saved as empty, no error)', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  const { setConfigValue } = await import('../../../src/db/adminConfigRepo.js');
  setConfigValue(db, 'zeitstempel_tsa_url', 'https://freetsa.org/tsr');
  const app = buildTestApp(db);
  const res = await request(app).post('/admin/zeitstempel').set('x-test-person-id', '99').type('form').send({ tsaUrl: '', tsaUser: '', warnungAbStunden: '2' });
  assert.equal(res.status, 302);
  assert.equal(getConfigValue(db, 'zeitstempel_tsa_url'), '');
  db.close();
});

test('POST /admin/zeitstempel rejects a TSA URL without http(s):// scheme, config untouched', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  const app = buildTestApp(db);
  const res = await request(app)
    .post('/admin/zeitstempel')
    .set('x-test-person-id', '99')
    .type('form')
    .send({ tsaUrl: 'ftp://tsa.example.org', tsaUser: '', warnungAbStunden: '2' });
  assert.equal(res.status, 400);
  assert.match(res.text, /muss leer sein.*oder mit http/);
  assert.equal(getConfigValue(db, 'zeitstempel_tsa_url'), '');
  db.close();
});

test('POST /admin/zeitstempel rejects a non-numeric or zero Warnschwelle, config untouched', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  const app = buildTestApp(db);
  const res = await request(app)
    .post('/admin/zeitstempel')
    .set('x-test-person-id', '99')
    .type('form')
    .send({ tsaUrl: 'https://freetsa.org/tsr', tsaUser: '', warnungAbStunden: '0' });
  assert.equal(res.status, 400);
  assert.match(res.text, /Warnschwelle/);
  assert.equal(getConfigValue(db, 'zeitstempel_tsa_url'), '');
  db.close();
});

async function passwortPost(felder) {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  setConfigValue(db, 'zeitstempel_tsa_passwort', 'altes-passwort');
  const res = await request(buildTestApp(db))
    .post('/admin/zeitstempel')
    .set('x-test-person-id', '99')
    .type('form')
    .send({ tsaUrl: 'https://freetsa.org/tsr', tsaUser: '', warnungAbStunden: '2', ...felder });
  assert.equal(res.status, 302);
  const wert = getConfigValue(db, 'zeitstempel_tsa_passwort');
  db.close();
  return wert;
}

test('POST /admin/zeitstempel with a blank password keeps the stored one', async () => {
  assert.equal(await passwortPost({ tsaPasswort: '' }), 'altes-passwort');
});

test('POST /admin/zeitstempel with tsaPasswortEntfernen clears the stored password', async () => {
  assert.equal(await passwortPost({ tsaPasswort: '', tsaPasswortEntfernen: '1' }), '');
});

test('POST /admin/zeitstempel with a new password replaces the stored one', async () => {
  assert.equal(await passwortPost({ tsaPasswort: 'neues-passwort' }), 'neues-passwort');
});

// --- Audit-Nachweis für die Revision ---

const BASIS = { tsaUrl: '', tsaUser: '', warnungAbStunden: '2' };
const AUDIT = {
  auditFormular: '1',
  auditRevisionEmpfaenger: 'revision@example.org',
  auditNachweisAktiv: '1',
  auditPruefnummerRhythmus: 'monatlich',
  auditPruefnummerTag: '1',
  auditExportStunde: '3',
  auditExportMinute: '15',
  auditPruefnummerStunde: '7',
  auditPruefnummerMinute: '0',
  auditZeitstempelAlarmTage: '3',
};

async function setup(t) {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  seedDefaults(db);
  seedAdmin(db);
  const mails = [];
  return { db, mails, app: buildTestApp(db, mails) };
}

function speichere(app, felder) {
  return request(app).post('/admin/zeitstempel').set('x-test-person-id', '99').type('form').send({ ...BASIS, ...AUDIT, ...felder });
}

function paket(db) {
  db.prepare(`INSERT INTO audit_export_pakete (von_id, bis_id, anzahl, luecken, inhalt_sha256, paket_sha256, erstellt_am)
    VALUES (1, 5, 5, '[]', ?, ?, '2026-10-01T03:15:00.000Z')`).run('a'.repeat(64), 'b'.repeat(64));
}

test('Superadmin speichert Empfänger; alte und neue Adresse bekommen Mail; admin_config-Änderung steht im Audit-Log', async (t) => {
  const { db, app, mails } = await setup(t);
  setConfigValue(db, 'audit_revision_empfaenger', 'alt@example.org');
  const res = await speichere(app, { auditRevisionEmpfaenger: ' neu@example.org , neu@example.org' });
  assert.equal(res.status, 302);
  assert.equal(getConfigValue(db, 'audit_revision_empfaenger'), 'neu@example.org');
  const wechsel = mails.filter((m) => /Empfänger der Audit-Prüfnummer/.test(m.subject));
  assert.deepEqual(wechsel.map((m) => m.to).sort(), ['alt@example.org', 'neu@example.org']);
  assert.match(wechsel[0].text, /Admina Portal/);
  const audit = db.prepare("SELECT * FROM audit_ereignisse WHERE objekt = 'admin_config' AND objekt_id = 'audit_revision_empfaenger'").all();
  assert.ok(audit.length >= 1);
});

test('unveränderter Empfänger → keine Wechsel-Mail', async (t) => {
  const { db, app, mails } = await setup(t);
  setConfigValue(db, 'audit_revision_empfaenger', 'revision@example.org');
  const res = await speichere(app, {});
  assert.equal(res.status, 302);
  assert.equal(mails.length, 0);
});

test('Abschalten oder Rhythmus/Tag ändern → Änderungs-Mail an Revisions-Empfänger', async (t) => {
  const { db, app, mails } = await setup(t);
  setConfigValue(db, 'audit_revision_empfaenger', 'revision@example.org');
  let res = await speichere(app, { auditNachweisAktiv: undefined });
  assert.equal(res.status, 302);
  assert.equal(getConfigValue(db, 'modul_audit_nachweis_aktiv'), '0');
  assert.equal(mails.length, 1);
  assert.equal(mails[0].to, 'revision@example.org');
  assert.match(mails[0].text, /Automatischer Nachweis: aktiv → abgeschaltet/);
  mails.length = 0;
  res = await speichere(app, { auditNachweisAktiv: '1', auditPruefnummerRhythmus: 'quartalsweise', auditPruefnummerTag: '15' });
  assert.equal(res.status, 302);
  assert.equal(mails.length, 1);
  assert.match(mails[0].text, /Automatischer Nachweis: abgeschaltet → aktiv/);
  assert.match(mails[0].text, /Versandrhythmus: monatlich → quartalsweise/);
  assert.match(mails[0].text, /Versandtag: 1 → 15/);
});

test('Empfänger und Rhythmus im selben Speichern → beide Mails', async (t) => {
  const { db, app, mails } = await setup(t);
  setConfigValue(db, 'audit_revision_empfaenger', 'alt@example.org');
  await speichere(app, { auditRevisionEmpfaenger: 'neu@example.org', auditPruefnummerRhythmus: 'jaehrlich' });
  assert.equal(mails.filter((m) => /Empfänger der Audit-Prüfnummer/.test(m.subject)).length, 2);
  // Änderungsmail geht an alte und neue Adresse (Empfängerwechsel)
  assert.equal(mails.filter((m) => /Einstellungen des Audit-Nachweises/.test(m.subject)).length, 2);
});

test('nur Uhrzeit oder Alarmschwelle ändern → keine Mail', async (t) => {
  const { db, app, mails } = await setup(t);
  setConfigValue(db, 'audit_revision_empfaenger', 'revision@example.org');
  const res = await speichere(app, { auditExportStunde: '4', auditPruefnummerMinute: '30', auditZeitstempelAlarmTage: '5' });
  assert.equal(res.status, 302);
  assert.equal(getConfigValue(db, 'cron_audit_export_stunde'), '4');
  assert.equal(getConfigValue(db, 'cron_audit_pruefnummer_minute'), '30');
  assert.equal(getConfigValue(db, 'audit_zeitstempel_alarm_tage'), '5');
  assert.equal(mails.length, 0);
});

test('ungültige Werte → 400, nichts gespeichert', async (t) => {
  const { db, app } = await setup(t);
  const faelle = [
    { auditPruefnummerTag: '29' }, { auditExportStunde: '24' }, { auditPruefnummerMinute: '60' },
    { auditZeitstempelAlarmTage: '0' }, { auditZeitstempelAlarmTage: '31' }, { auditPruefnummerRhythmus: 'woechentlich' },
  ];
  for (const fall of faelle) {
    const res = await speichere(app, { tsaUrl: 'https://tsa.example.org/tsr', ...fall });
    assert.equal(res.status, 400, JSON.stringify(fall));
  }
  assert.equal(getConfigValue(db, 'zeitstempel_tsa_url'), '');
  assert.equal(getConfigValue(db, 'audit_pruefnummer_tag'), '1');
  assert.equal(getConfigValue(db, 'audit_revision_empfaenger'), '');
});

test('ungültige Adresse → 400, nichts gespeichert, eingegebene Werte bleiben im Formular', async (t) => {
  const { db, app } = await setup(t);
  const res = await speichere(app, { auditRevisionEmpfaenger: 'gut@example.org, kaputt', auditPruefnummerTag: '12' });
  assert.equal(res.status, 400);
  assert.match(res.text, /kaputt/);
  assert.match(res.text, /id="auditPruefnummerTag"[^>]*value="12"/);
  assert.equal(getConfigValue(db, 'audit_revision_empfaenger'), '');
});

test('Seite zeigt alle Einstellungen vorbelegt mit den gespeicherten Werten', async (t) => {
  const { db, app } = await setup(t);
  setConfigValue(db, 'audit_revision_empfaenger', 'a@example.org, b@example.org');
  setConfigValue(db, 'modul_audit_nachweis_aktiv', '0');
  setConfigValue(db, 'audit_pruefnummer_rhythmus', 'quartalsweise');
  setConfigValue(db, 'audit_pruefnummer_tag', '14');
  setConfigValue(db, 'cron_audit_export_stunde', '5');
  setConfigValue(db, 'cron_audit_export_minute', '25');
  setConfigValue(db, 'cron_audit_pruefnummer_stunde', '9');
  setConfigValue(db, 'cron_audit_pruefnummer_minute', '35');
  setConfigValue(db, 'audit_zeitstempel_alarm_tage', '6');
  const res = await request(app).get('/admin/zeitstempel').set('x-test-person-id', '99');
  assert.equal(res.status, 200);
  assert.match(res.text, /id="auditRevisionEmpfaenger"[^>]*>a@example\.org, b@example\.org</);
  assert.doesNotMatch(res.text, /id="auditNachweisAktiv"[^>]*checked/);
  assert.match(res.text, /<option value="quartalsweise" selected>/);
  assert.match(res.text, /id="auditPruefnummerTag"[^>]*value="14"/);
  assert.match(res.text, /id="auditExportStunde"[^>]*value="5"/);
  assert.match(res.text, /id="auditExportMinute"[^>]*value="25"/);
  assert.match(res.text, /id="auditPruefnummerStunde"[^>]*value="9"/);
  assert.match(res.text, /id="auditPruefnummerMinute"[^>]*value="35"/);
  assert.match(res.text, /id="auditZeitstempelAlarmTage"[^>]*value="6"/);
});

test('Adresse eines Superadmins → gespeichert, Seite zeigt Warnung', async (t) => {
  const { db, app } = await setup(t);
  const res = await speichere(app, { auditRevisionEmpfaenger: 'Admin@Example.org' });
  assert.equal(res.status, 302);
  assert.equal(getConfigValue(db, 'audit_revision_empfaenger'), 'Admin@Example.org');
  const seite = await request(app).get('/admin/zeitstempel').set('x-test-person-id', '99');
  assert.match(seite.text, /gehört einer Person mit Admin-Rechten/);
});

test('„Prüfnummer jetzt senden“ verschickt Mail bzw. zeigt „kein Empfänger festgelegt“', async (t) => {
  const { db, app, mails } = await setup(t);
  paket(db);
  let res = await request(app).post('/admin/zeitstempel/audit-pruefnummer-senden').set('x-test-person-id', '99');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/admin/zeitstempel?versand=kein_empfaenger');
  assert.equal(mails.length, 0);
  let seite = await request(app).get(res.headers.location).set('x-test-person-id', '99');
  assert.match(seite.text, /kein Empfänger festgelegt/);
  setConfigValue(db, 'audit_revision_empfaenger', 'revision@example.org');
  res = await request(app).post('/admin/zeitstempel/audit-pruefnummer-senden').set('x-test-person-id', '99');
  assert.equal(res.headers.location, '/admin/zeitstempel?versand=versendet');
  assert.equal(mails.length, 1);
  assert.equal(getConfigValue(db, 'audit_pruefnummer_zuletzt_monat'), null);
  seite = await request(app).get(res.headers.location).set('x-test-person-id', '99');
  assert.match(seite.text, /Prüfnummer wurde versendet/);
});

test('Seite zeigt letztes Paket, Anzahl ohne Zeitstempel und Hinweis bei fehlendem Empfänger', async (t) => {
  const { db, app } = await setup(t);
  paket(db);
  const res = await request(app).get('/admin/zeitstempel').set('x-test-person-id', '99');
  assert.match(res.text, /Letztes Paket: Nr\. 1/);
  assert.match(res.text, /1 Paket[^<]*ohne Zeitstempel/);
  assert.match(res.text, /Kein Revisions-Empfänger festgelegt/);
});

test('Nicht-Superadmin → 403 für den manuellen Versand', async (t) => {
  const { db, app } = await setup(t);
  upsertPerson(db, { id: '77', vorname: 'N', nachname: 'B', email: 'b@example.org', gruppen: ['10'], loggedInNow: true });
  const res = await request(app).post('/admin/zeitstempel/audit-pruefnummer-senden').set('x-test-person-id', '77');
  assert.equal(res.status, 403);
});

test('alter Formular-Post ohne Audit-Felder lässt die Audit-Einstellungen unverändert', async (t) => {
  const { db, app, mails } = await setup(t);
  setConfigValue(db, 'audit_pruefnummer_tag', '9');
  setConfigValue(db, 'modul_audit_nachweis_aktiv', '0');
  const res = await request(app).post('/admin/zeitstempel').set('x-test-person-id', '99').type('form').send(BASIS);
  assert.equal(res.status, 302);
  assert.equal(getConfigValue(db, 'audit_pruefnummer_tag'), '9');
  assert.equal(getConfigValue(db, 'modul_audit_nachweis_aktiv'), '0');
  assert.equal(mails.length, 0);
});

test('Empfänger ersetzen und abschalten im selben POST → "abgeschaltet"-Mail geht an alte und neue Adresse', async (t) => {
  const { db, app, mails } = await setup(t);
  setConfigValue(db, 'audit_revision_empfaenger', 'alt@example.org');
  await speichere(app, { auditRevisionEmpfaenger: 'neu@example.org', auditNachweisAktiv: undefined });
  const mailsAbgeschaltet = mails.filter((m) => /Einstellungen des Audit-Nachweises/.test(m.subject));
  assert.deepEqual(mailsAbgeschaltet.map((m) => m.to).sort(), ['alt@example.org', 'neu@example.org']);
  assert.match(mailsAbgeschaltet[0].text, /aktiv → abgeschaltet/);
});
