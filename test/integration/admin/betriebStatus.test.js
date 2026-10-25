import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { openDatabase } from '../../../src/db/index.js';
import { seedDefaults, getConfigValue, setConfigValue } from '../../../src/db/adminConfigRepo.js';
import { upsertPerson } from '../../../src/db/personenRepo.js';
import { setBerechtigungenForPerson } from '../../../src/db/personBerechtigungenRepo.js';
import { loadCurrentPerson } from '../../../src/middleware/roles.js';
import { requirePermission } from '../../../src/middleware/permissions.js';
import { loadNavFlags } from '../../../src/middleware/nav.js';
import { createApp } from '../../../src/app.js';
import { createBetriebRouter } from '../../../src/routes/admin/betrieb.js';
import { createHash } from 'node:crypto';

const hash = (k) => createHash('sha256').update(k).digest('hex');
const angezeigt = (html) => html.match(/id="neuerSchluessel">([0-9a-f]{64})</)?.[1];

const DIENSTE_NAMEN = ['Datenbank', 'Sicherung', 'Mailversand', 'ChurchTools', 'Zeitstempel', 'Audit-Nachweis', 'Archivübergabe', 'Speicher', 'Geplante Jobs', 'Sicherheitsalarme', 'Ersteinrichtung'];
const GUELTIG = {
  status_sicherung_warnung_stunden: '26', status_sicherung_fehler_stunden: '50', status_mail_wartezeit_fehler_minuten: '60',
  status_churchtools_warnung_stunden: '26', status_churchtools_fehler_stunden: '50', status_zeitstempel_crl_warnung_tage: '7',
  status_archiv_warnung_stunden: '48', status_archiv_fehler_tage: '7', status_speicher_warnung_prozent: '15', status_speicher_fehler_prozent: '5',
};

function buildTestApp(db) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', new URL('../../../views', import.meta.url).pathname);
  app.use((req, res, next) => {
    res.locals.branding = { primaryColor: '#000', secondaryColor: '#fff', hasLogo: false, themeAttr: null };
    next();
  });
  app.use(express.urlencoded({ extended: false }));
  app.use((req, res, next) => { req.session = { personId: req.headers['x-test-person-id'] }; next(); });
  const config = { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20', groupIdManager: '30' }, publicBaseUrl: 'https://portal.example.org', jobsDir: '/tmp/freigabeportal-status-test-jobs' };
  app.use(loadCurrentPerson(db));
  app.use(loadNavFlags(db, config));
  app.use('/admin/betrieb', requirePermission(db, config, 'betrieb_einsehen'), createBetriebRouter({ db, config }));
  return app;
}

function setup() {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  upsertPerson(db, { id: '7', vorname: 'Bea', nachname: 'Trieb', email: 'bea@example.org', gruppen: [], loggedInNow: true });
  upsertPerson(db, { id: '8', vorname: 'Otto', nachname: 'Ohne', email: 'otto@example.org', gruppen: [], loggedInNow: true });
  upsertPerson(db, { id: '55', vorname: 'Mana', nachname: 'Ger', email: 'manager@example.org', gruppen: ['30'], loggedInNow: true });
  upsertPerson(db, { id: '9', vorname: 'Ad', nachname: 'Min', email: 'admin@example.org', gruppen: ['20'], loggedInNow: true });
  setBerechtigungenForPerson(db, '7', ['betrieb_einsehen']);
  setBerechtigungenForPerson(db, '8', ['mails_einsehen']);
  return { db, app: buildTestApp(db) };
}
const als = (app, id) => request(app).get('/admin/betrieb/status').set('x-test-person-id', id);

test('Zugang: nur mit betrieb_einsehen', async () => {
  const { db, app } = setup();
  assert.equal((await als(app, '7')).status, 200);
  assert.equal((await als(app, '8')).status, 403);
  assert.equal((await als(app, '55')).status, 403);
  db.close();
});

test('zeigt alle Dienste mit Ampel, Gesamtstatus und Reiter', async () => {
  const { db, app } = setup();
  const res = await als(app, '7');
  for (const name of DIENSTE_NAMEN) assert.match(res.text, new RegExp(name), name);
  assert.match(res.text, /Gesamtstatus/);
  assert.match(res.text, /href="\/admin\/betrieb\/status"/);
  assert.match(res.text, /nicht eingerichtet/);
  db.close();
});

test('Grenzwerte: speichern, ungültig → 400 und nichts gespeichert', async () => {
  const { db, app } = setup();
  const post = (body) => request(app).post('/admin/betrieb/status/grenzwerte').type('form').set('x-test-person-id', '7').send(body);
  const ok = await post({ ...GUELTIG, status_sicherung_warnung_stunden: '30' });
  assert.equal(ok.status, 302);
  assert.equal(getConfigValue(db, 'status_sicherung_warnung_stunden'), '30');
  for (const schlecht of [
    { status_sicherung_fehler_stunden: '0' },
    { status_sicherung_fehler_stunden: 'abc' },
    { status_sicherung_fehler_stunden: '1.5' },
    { status_sicherung_warnung_stunden: '60' }, // Warnung > Fehler (50)
    { status_speicher_fehler_prozent: '20' }, // Fehler muss unter Warnung (15) liegen
    { status_speicher_warnung_prozent: '101' },
  ]) {
    const res = await post({ ...GUELTIG, status_sicherung_warnung_stunden: '30', ...schlecht });
    assert.equal(res.status, 400, JSON.stringify(schlecht));
  }
  assert.equal(getConfigValue(db, 'status_sicherung_warnung_stunden'), '30');
  assert.notEqual(getConfigValue(db, 'status_sicherung_fehler_stunden'), '0');
  assert.equal((await post({ status_sicherung_warnung_stunden: '5' })).status, 400); // unvollständig
  db.close();
});

test('Schlüssel erzeugen zeigt ihn einmal, danach nie mehr; Audit ohne Klartext', async () => {
  const { db, app } = setup();
  const res = await request(app).post('/admin/betrieb/status/schluessel').type('form').set('x-test-person-id', '7').send({ aktion: 'erzeugen' });
  assert.equal(res.status, 200);
  const key = angezeigt(res.text);
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(getConfigValue(db, 'monitoring_secret'), hash(key), 'nur der SHA-256 des Schlüssels wird gespeichert');
  assert.match(res.text, /X-Monitoring-Key/);
  assert.match(res.text, /dienste\.sicherung\.status/);
  assert.match(res.text, /https:\/\/portal\.example\.org\/healthz/);
  assert.match(res.headers['cache-control'], /no-store/);
  const danach = await als(app, '7');
  assert.ok(!danach.text.includes(key));
  assert.match(danach.text, /eingerichtet/);
  const audit = JSON.stringify(db.prepare('SELECT * FROM audit_ereignisse').all());
  assert.ok(!audit.includes(key), 'Klartextschlüssel im Audit-Log');
  const zeilen = db.prepare('SELECT * FROM audit_ereignisse').all().filter((z) => JSON.stringify(z).includes('monitoring_secret'));
  assert.ok(zeilen.length >= 1, 'kein Audit-Eintrag zu monitoring_secret');
  assert.ok(zeilen.some((z) => JSON.stringify(z).includes('[redacted]')), 'Wert nicht als [redacted] protokolliert');
  db.close();
});

test('Schlüssel entfernen leert den Wert; unbekannte Aktion → 400', async () => {
  const { db, app } = setup();
  setConfigValue(db, 'monitoring_secret', 'ab'.repeat(32));
  const post = (aktion) => request(app).post('/admin/betrieb/status/schluessel').type('form').set('x-test-person-id', '7').send({ aktion });
  assert.equal((await post('boese')).status, 400);
  assert.equal(getConfigValue(db, 'monitoring_secret'), 'ab'.repeat(32));
  assert.equal((await post('entfernen')).status, 302);
  assert.equal(getConfigValue(db, 'monitoring_secret'), '');
  db.close();
});

test('Schlüssel steuert /healthz im echten createApp: erzeugen → Details, entfernen → Kurzantwort', async () => {
  const { db, app } = setup();
  const res = await request(app).post('/admin/betrieb/status/schluessel').type('form').set('x-test-person-id', '7').send({ aktion: 'erzeugen' });
  const key = angezeigt(res.text);
  assert.equal(res.status, 200);
  const vollApp = createApp({
    db,
    config: { sessionSecret: 'test-secret', env: 'test', churchtools: { baseUrl: 'https://ct.example.org', groupIdBuchhaltung: '10', groupIdAdmin: '20' }, n8nApiKey: 'k', downloadSigningSecret: 's', jobsDir: '/tmp/freigabeportal-status-test-jobs' },
  });
  const mit = await request(vollApp).get('/healthz').set('X-Monitoring-Key', key);
  assert.equal(mit.status, 200);
  assert.ok(mit.body.dienste && mit.body.dienste.datenbank, 'Details fehlen');
  await request(app).post('/admin/betrieb/status/schluessel').type('form').set('x-test-person-id', '7').send({ aktion: 'entfernen' });
  const ohne = await request(vollApp).get('/healthz').set('X-Monitoring-Key', key);
  assert.equal(ohne.text, '{"status":"ok"}');
  db.close();
});

test('Schlüssel neu erzeugen bei vorhandenem Schlüssel nur mit Bestätigung', async () => {
  const { db, app } = setup();
  setConfigValue(db, 'monitoring_secret', hash('alt'));
  const post = (body) => request(app).post('/admin/betrieb/status/schluessel').type('form').set('x-test-person-id', '7').send(body);
  const seite = await als(app, '7');
  assert.match(seite.text, /Ich weiss, dass der bisherige Schlüssel ungültig wird/);
  const ohne = await post({ aktion: 'erzeugen' });
  assert.equal(ohne.status, 400);
  assert.match(ohne.text, /bestätige/);
  assert.equal(getConfigValue(db, 'monitoring_secret'), hash('alt'));
  const mit = await post({ aktion: 'erzeugen', bestaetigt: '1' });
  assert.equal(mit.status, 200);
  const key = angezeigt(mit.text);
  assert.equal(getConfigValue(db, 'monitoring_secret'), hash(key));
  db.close();
});

test('Statusseite: Ergebnis 30 s zwischengespeichert, "Jetzt neu prüfen" umgeht den Cache, Grenzwerte leeren ihn', async () => {
  const { db, app } = setup();
  const erste = await als(app, '7');
  assert.match(erste.text, /href="\/admin\/betrieb\/status\?neu=1"[^>]*>Jetzt neu prüfen/);
  db.prepare("INSERT INTO sicherheitsalarme (alarm_typ, schluessel, erkannt_am, naechster_versuch_am) VALUES ('backup_loeschung_offen', 'k', ?, ?)").run(new Date().toISOString(), new Date().toISOString());
  assert.doesNotMatch((await als(app, '7')).text, /offene\(r\) Sicherheitsalarm/);
  const neu = await request(app).get('/admin/betrieb/status?neu=1').set('x-test-person-id', '7');
  assert.match(neu.text, /offene\(r\) Sicherheitsalarm/);
  db.prepare("UPDATE sicherheitsalarme SET status = 'erledigt'").run();
  await request(app).post('/admin/betrieb/status/grenzwerte').type('form').set('x-test-person-id', '7').send(GUELTIG);
  assert.doesNotMatch((await als(app, '7')).text, /offene\(r\) Sicherheitsalarm/);
  db.close();
});
