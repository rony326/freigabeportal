import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { openDatabase } from '../../../src/db/index.js';
import { getConfigValue, setConfigValue } from '../../../src/db/adminConfigRepo.js';
import { setBerechtigungenForPerson } from '../../../src/db/personBerechtigungenRepo.js';
import { createApp } from '../../../src/app.js';
import { setupMockChurchTools } from '../../helpers/mockChurchTools.js';
import { fetchCsrfToken } from '../../helpers/csrf.js';
import { pruefeAlleDienste } from '../../../src/services/statusPruefungen.js';
import { einrichtungsStand } from '../../../src/services/ersteinrichtung.js';
import { pruefeTechnik } from '../../../src/services/einrichtungTests.js';

const GEHEIM = ['sync-token-geheim', 'client-secret-geheim', 'smtp-passwort-geheim'];

function setup(t) {
  const db = openDatabase(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'einr-int-'));
  const config = {
    sessionSecret: 'test-secret',
    env: 'test',
    dbPath: join(dir, 'db.sqlite'),
    jobsDir: join(dir, 'jobs'),
    brandingDir: join(dir, 'branding'),
    backupDir: join(dir, 'backups'),
    churchtools: {
      baseUrl: 'https://ct.example.org', clientId: 'cid', clientSecret: GEHEIM[1],
      redirectUri: 'https://portal.example.org/auth/callback',
      groupIdBuchhaltung: '10', groupIdAdmin: '20', groupIdManager: '30', syncServiceToken: GEHEIM[0],
    },
    cronSecret: 'cron-secret', n8nApiKey: 'n8n-key', downloadSigningSecret: 'download-secret',
    smtp: { host: 'smtp.example.org', port: 587, user: 'user', pass: GEHEIM[2], from: 'portal@example.org' },
    backupKeyringFile: join(dir, 'keyring.json'),
  };
  writeFileSync(config.backupKeyringFile, JSON.stringify({ version: 1, activeKeyId: 'k1', keys: [{ id: 'k1', keyHex: 'cd'.repeat(32) }] }), { mode: 0o600 });
  chmodSync(config.backupKeyringFile, 0o600);
  const gesendet = [];
  const mailer = { async sendMail(m) { gesendet.push(m); } };
  // TSA-Probe gelingt immer (kein Netz im Test).
  const app = createApp({ db, config, mailer, tsaVersuch: async () => {} });
  const ct = setupMockChurchTools(config.churchtools.baseUrl);
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  return { db, config, app, ct, gesendet };
}

let nextId = 1;
async function loginAs({ app, ct }, { gruppen, email = 'person@example.org' }) {
  const id = nextId++;
  ct.intercept({ path: '/oauth/access_token', method: 'POST' }).reply(200, { access_token: `tok-${id}` });
  ct.intercept({ path: '/oauth/userinfo', method: 'GET' }).reply(200, { id, firstName: 'Vor', lastName: 'Name', email });
  for (const g of ['10', '20', '30']) {
    ct.intercept({ path: `/api/groups/${g}/members`, method: 'GET' }).reply(200, { data: gruppen.includes(g) ? [{ personId: id }] : [] });
  }
  const agent = request.agent(app);
  const l = await agent.get('/auth/login');
  const state = new URL(l.headers.location).searchParams.get('state');
  const cb = await agent.get('/auth/callback').query({ code: `c${id}`, state });
  assert.equal(cb.status, 302);
  return { agent, id: String(id) };
}
const admin = (s, extra = {}) => loginAs(s, { gruppen: ['20'], email: 'admin@example.org', ...extra });
async function post(agent, pfad, body = {}) {
  const token = await fetchCsrfToken(agent, '/admin/ersteinrichtung');
  return agent.post(`/admin/ersteinrichtung${pfad}`).type('form').send({ _csrf: token, ...body });
}
const audit = (db, aktion) => db.prepare("SELECT * FROM audit_ereignisse WHERE objekt = 'ersteinrichtung' AND aktion = ?").all(aktion);

test('Zugang: Superadmin 200, Manager und Person mit betrieb_einsehen 403', async (t) => {
  const s = setup(t);
  const { agent: a } = await admin(s);
  assert.equal((await a.get('/admin/ersteinrichtung')).status, 200);
  const { agent: m } = await loginAs(s, { gruppen: ['30'] });
  assert.equal((await m.get('/admin/ersteinrichtung')).status, 403);
  const { agent: b, id } = await loginAs(s, { gruppen: [] });
  setBerechtigungenForPerson(s.db, id, ['betrieb_einsehen']);
  assert.equal((await b.get('/admin/ersteinrichtung')).status, 403);
});

test('frische Installation lädt: alle Schritte, Fortschritt, keine Geheimnisse', async (t) => {
  const s = setup(t);
  const { agent } = await admin(s);
  const res = await agent.get('/admin/ersteinrichtung');
  assert.equal(res.status, 200);
  for (const id of ['grundlagen', 'rollen', 'churchtools', 'mail', 'konten', 'zeitstempel', 'sicherung', 'kontakt', 'branding', 'kreditoren', 'module', 'mailvorlagen', 'monitoring', 'jobs']) {
    assert.match(res.text, new RegExp(`id="schritt-${id}"`), id);
  }
  assert.match(res.text, /von 8 Pflichtschritten/);
  assert.match(res.text, /Pflicht/);
  assert.match(res.text, /Optional/);
  for (const g of GEHEIM) assert.ok(!res.text.includes(g), 'Geheimnis in HTML');
  assert.ok(!res.text.includes('portal.example.org'));
});

test('technische Prüfung erneut: Audit-Eintrag, Ergebnis auf der Seite', async (t) => {
  const s = setup(t);
  const { agent } = await admin(s);
  const res = await post(agent, '/technik');
  assert.equal(res.status, 302);
  assert.equal(audit(s.db, 'test_technik').length, 1);
  const seite = await agent.get('/admin/ersteinrichtung');
  assert.match(seite.text, /Speicherort Belege/);
});

test('ChurchTools-Test: Erfolg zeigt Gruppen, Fehler zeigt feste Meldung, Audit ohne Geheimnis', async (t) => {
  const s = setup(t);
  const { agent } = await admin(s);
  for (const [id, name] of [['10', 'Buchhaltung'], ['20', 'Admin'], ['30', 'Manager']]) {
    s.ct.intercept({ path: `/api/groups/${id}` }).reply(200, { data: { id: Number(id), name: `Gruppe ${name}` } });
    s.ct.intercept({ path: `/api/groups/${id}/members` }).reply(200, { data: [{ personId: 1 }] });
  }
  assert.equal((await post(agent, '/churchtools-test')).status, 302);
  let seite = await agent.get('/admin/ersteinrichtung');
  assert.match(seite.text, /Gruppe Buchhaltung/);
  s.ct.intercept({ path: /\/api\/groups\/.*/ }).reply(401, {}).persist();
  await post(agent, '/churchtools-test');
  seite = await agent.get('/admin/ersteinrichtung');
  assert.match(seite.text, /lehnt den Zugang ab/);
  const rows = audit(s.db, 'test_churchtools');
  assert.equal(rows.length, 2);
  for (const r of rows) for (const g of GEHEIM) assert.ok(!JSON.stringify(r).includes(g));
});

test('Testmail: geht an die eigene Adresse, macht den Schritt mail erledigt', async (t) => {
  const s = setup(t);
  const { agent } = await admin(s);
  assert.equal((await post(agent, '/testmail')).status, 302);
  assert.equal(s.gesendet.length, 1);
  assert.equal(s.gesendet[0].to, 'admin@example.org');
  assert.equal(audit(s.db, 'test_testmail').length, 1);
  const seite = await agent.get('/admin/ersteinrichtung');
  assert.match(seite.text, /Die Testmail wurde verschickt/);
});

test('Testmail ohne Adresse: Meldung, keine Mail', async (t) => {
  const s = setup(t);
  const { agent } = await admin(s, { email: '' });
  await post(agent, '/testmail');
  assert.equal(s.gesendet.length, 0);
  const seite = await agent.get('/admin/ersteinrichtung');
  assert.match(seite.text, /keine E-Mail-Adresse/);
});

test('Jobs auslösen: Audit-Eintrag, Ergebnis je Job', async (t) => {
  const s = setup(t);
  const { agent } = await admin(s);
  s.ct.intercept({ path: /\/api\/.*/ }).reply(500, {}).persist();
  assert.equal((await post(agent, '/jobs')).status, 302);
  assert.equal(audit(s.db, 'test_jobs').length, 1);
  assert.ok(s.db.prepare("SELECT 1 FROM cron_log WHERE job = 'pool-erinnerungen'").get());
  const seite = await agent.get('/admin/ersteinrichtung');
  for (const name of ['Personen-Abgleich', 'Erinnerungen', 'Mailzustellung']) assert.match(seite.text, new RegExp(`<strong>${name}</strong>: `), name);
  assert.match(seite.text, /<strong>Personen-Abgleich<\/strong>: fehlgeschlagen/);
  assert.match(seite.text, /<strong>Mailzustellung<\/strong>: nichts zu tun/);
  assert.doesNotMatch(seite.text, /\((sync-personen|pool-erinnerungen|mail-zustellung)\)/);
});

test('markieren: nur manuelle Schritte, Audit über admin_config', async (t) => {
  const s = setup(t);
  const { agent } = await admin(s);
  assert.equal((await post(agent, '/markieren', { id: 'module', wert: '1' })).status, 302);
  assert.equal(getConfigValue(s.db, 'einrichtung_markiert_module'), '1');
  assert.ok(s.db.prepare("SELECT 1 FROM audit_ereignisse WHERE objekt = 'admin_config' AND objekt_id = 'einrichtung_markiert_module'").get());
  assert.equal((await post(agent, '/markieren', { id: 'module', wert: '0' })).status, 302);
  assert.equal(getConfigValue(s.db, 'einrichtung_markiert_module'), '0');
  for (const id of ['konten', 'unbekannt', '']) {
    assert.equal((await post(agent, '/markieren', { id, wert: '1' })).status, 400, id);
  }
  assert.equal(getConfigValue(s.db, 'einrichtung_markiert_konten'), null);
});

test('ohne-zeitstempel setzt und löscht den Verzicht', async (t) => {
  const s = setup(t);
  const { agent } = await admin(s);
  await post(agent, '/ohne-zeitstempel', { wert: '1' });
  assert.equal(getConfigValue(s.db, 'einrichtung_ohne_zeitstempel'), '1');
  await post(agent, '/ohne-zeitstempel', { wert: '0' });
  assert.equal(getConfigValue(s.db, 'einrichtung_ohne_zeitstempel'), '0');
});

test('Dashboard-Hinweis: sichtbar, "später" blendet 7 Tage aus, nach Abschluss weg, nur Superadmin', async (t) => {
  const s = setup(t);
  const { agent, id } = await admin(s);
  let dash = await agent.get('/admin');
  assert.match(dash.text, /Ersteinrichtung: \d+ von 8 Pflichtschritten erledigt/);
  assert.match(dash.text, /href="\/admin\/ersteinrichtung"/);

  assert.equal((await post(agent, '/spaeter')).status, 302);
  const bis = getConfigValue(s.db, `einrichtung_spaeter_bis_${id}`);
  const tage = (new Date(bis).getTime() - Date.now()) / 86400000;
  assert.ok(tage > 6.9 && tage <= 7.01, `7 Tage, war ${tage}`);
  dash = await agent.get('/admin');
  assert.doesNotMatch(dash.text, /Pflichtschritten erledigt/);

  setConfigValue(s.db, `einrichtung_spaeter_bis_${id}`, new Date(Date.now() - 1000).toISOString());
  dash = await agent.get('/admin');
  assert.match(dash.text, /Pflichtschritten erledigt/);
});

test('Dashboard-Hinweis nicht für Manager', async (t) => {
  const s = setup(t);
  const { agent } = await loginAs(s, { gruppen: ['30'] });
  const dash = await agent.get('/admin');
  assert.equal(dash.status, 200);
  assert.doesNotMatch(dash.text, /Pflichtschritten erledigt/);
});

test('Navigation: Eintrag Ersteinrichtung nur für Superadmin', async (t) => {
  const s = setup(t);
  const { agent } = await admin(s);
  assert.match((await agent.get('/admin')).text, /href="\/admin\/ersteinrichtung"/);
  const { agent: m } = await loginAs(s, { gruppen: ['30'] });
  assert.doesNotMatch((await m.get('/admin')).text, /href="\/admin\/ersteinrichtung"/);
});

test('Statusdienst einrichtung: warnung mit Anzahl, bei Abschluss ok', async (t) => {
  const s = setup(t);
  const offen = pruefeAlleDienste(s.db, s.config).dienste.einrichtung;
  assert.equal(offen.status, 'warnung');
  assert.match(offen.grund, /\d+ von 8 Pflichtschritten offen/);
  assert.doesNotMatch(offen.grund, /\/|https?:/);
});

test('Ergebnisse sind pro Person getrennt und nennen Person und Zeit', async (t) => {
  const s = setup(t);
  const { agent: a1 } = await admin(s);
  const { agent: a2 } = await admin(s, { email: 'zweite@example.org' });
  await post(a1, '/testmail');
  const eigene = await a1.get('/admin/ersteinrichtung');
  assert.match(eigene.text, /Die Testmail wurde verschickt/);
  assert.match(eigene.text, /von Vor Name, \d{2}\.\d{2}\.\d{4} \d{2}:\d{2}/);
  const fremde = await a2.get('/admin/ersteinrichtung');
  assert.doesNotMatch(fremde.text, /Die Testmail wurde verschickt/);
});

// Alle Pflichtschritte erledigen, wie in der Betriebsumgebung.
function alleSchritteErledigen({ db, config }) {
  config.publicBaseUrl = 'https://portal.example.org';
  config.tsaTrustAnchorsFile = join(dirname(config.dbPath), 'tsa-anker.pem');
  writeFileSync(config.tsaTrustAnchorsFile, 'anker');
  config.tsaTrustAnchorsSha256 = 'a'.repeat(64);
  for (const d of [config.jobsDir, config.brandingDir, config.backupDir]) mkdirSync(d, { recursive: true });
  const jetzt = new Date().toISOString();
  db.prepare("INSERT INTO personen (churchtools_person_id, vorname, nachname, email, gruppen, aktiv) VALUES ('901', 'Anna', 'Admin', 'anna@x.ch', '[\"20\"]', 1)").run();
  db.prepare("INSERT INTO personen (churchtools_person_id, vorname, nachname, email, gruppen, aktiv) VALUES ('902', 'Max', 'Manager', 'max@x.ch', '[\"30\"]', 1)").run();
  db.prepare("INSERT INTO sync_log (gestartet_am, beendet_am, status) VALUES (?, ?, 'erfolg')").run(jetzt, jetzt);
  db.prepare("INSERT INTO mail_log (typ, job_id, empfaenger, betreff, text, status, versucht_am) VALUES ('testmail', NULL, 'anna@x.ch', 'B', 'T', 'versendet', ?)").run(jetzt);
  db.prepare("INSERT INTO konten (kontonummer, bezeichnung, freigeber1_id, stellvertreter1_id, freigeber2_id, stellvertreter2_id, aktiv) VALUES ('1000', 'K', '901', '901', '902', '902', 1)").run();
  setConfigValue(db, 'zeitstempel_tsa_url', 'https://tsa.example.org/tsr');
  db.prepare('INSERT INTO cron_log (job, gestartet_am, beendet_am, status) VALUES (?, ?, ?, ?)').run('datenbank-sicherung', jetzt, jetzt, 'erfolg');
  setConfigValue(db, 'betrieb_kontakt_email', 'it@x.ch');
}

test('Dashboard-Hinweis verschwindet, sobald alle Pflichtschritte erledigt sind', async (t) => {
  const s = setup(t);
  const { agent } = await admin(s);
  alleSchritteErledigen(s);
  // Positivkontrolle: wirklich alle Pflichtschritte erledigt (nicht nur ausgeblendet).
  const stand = einrichtungsStand(s.db, s.config, { technik: pruefeTechnik(s.config) });
  assert.deepEqual(stand.schritte.filter((x) => x.pflicht && !x.erledigt).map((x) => x.id), []);
  assert.equal(stand.pflichtOffen, 0);
  const dash = await agent.get('/admin');
  assert.equal(dash.status, 200);
  assert.doesNotMatch(dash.text, /Pflichtschritten erledigt/);
});

test('Abschluss: Statusdienst ok und Hinweis bleibt aus, auch wenn die Testmail-Zeile später fehlt', async (t) => {
  const s = setup(t);
  const { agent } = await admin(s);
  assert.match((await agent.get('/admin')).text, /Pflichtschritten erledigt/);
  assert.equal(getConfigValue(s.db, 'einrichtung_abgeschlossen_am'), null);
  alleSchritteErledigen(s);
  // Abschluss wird beim ersten Messen ohne offene Pflichtschritte festgehalten (hier über das Dashboard).
  assert.doesNotMatch((await agent.get('/admin')).text, /Pflichtschritten erledigt/);
  const am = getConfigValue(s.db, 'einrichtung_abgeschlossen_am');
  assert.ok(am && Number.isFinite(Date.parse(am)), 'Abschluss festgehalten');
  const datum = new Intl.DateTimeFormat('de-CH', { timeZone: 'Europe/Zurich', day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(am));
  let dienst = pruefeAlleDienste(s.db, s.config).dienste.einrichtung;
  assert.deepEqual(dienst, { status: 'ok', aktiv: false, grund: `Einrichtung abgeschlossen am ${datum}` });

  s.db.prepare("DELETE FROM mail_log WHERE typ = 'testmail'").run();
  assert.equal(einrichtungsStand(s.db, s.config, { technik: pruefeTechnik(s.config) }).pflichtOffen, 1);
  dienst = pruefeAlleDienste(s.db, s.config).dienste.einrichtung;
  assert.equal(dienst.status, 'ok');
  assert.equal(dienst.aktiv, false);
  assert.doesNotMatch((await agent.get('/admin')).text, /Pflichtschritten erledigt/);
  assert.equal(getConfigValue(s.db, 'einrichtung_abgeschlossen_am'), am);

  // Assistent: Banner mit Datum, Schritt mail zeigt den echten (offenen) Stand, keine Go-Live-Prüfung.
  const seite = await agent.get('/admin/ersteinrichtung');
  assert.match(seite.text, new RegExp(`Einrichtung abgeschlossen am ${datum.replace(/\./g, '\\.')}`));
  const mailKarte = seite.text.slice(seite.text.indexOf('id="schritt-mail"'), seite.text.indexOf('id="schritt-konten"'));
  assert.match(mailKarte, />Offen</);
  assert.doesNotMatch(seite.text, /Go-Live-Prüfung/);
});

test('Go-Live-Prüfung: erst nach allen Pflichtschritten, mit Status, Testmail, Sicherung und README-Hinweis', async (t) => {
  const s = setup(t);
  const { agent } = await admin(s);
  assert.doesNotMatch((await agent.get('/admin/ersteinrichtung')).text, /Go-Live-Prüfung/);
  alleSchritteErledigen(s);
  const seite = await agent.get('/admin/ersteinrichtung');
  assert.match(seite.text, /id="go-live"/);
  assert.match(seite.text, /Go-Live-Prüfung/);
  assert.match(seite.text, /Die Statusseite meldet keinen Fehler/);
  assert.match(seite.text, /Eine Testmail wurde zugestellt/);
  assert.match(seite.text, /Eine aktuelle Sicherung ist vorhanden/);
  assert.match(seite.text, /Go-Live-Checkliste/);
  const goLive = seite.text.slice(seite.text.indexOf('id="go-live"'));
  assert.doesNotMatch(goLive, /text-bg-danger/);
});

test('Schritt rollen: nennt Superadmins und Manager ohne E-Mail, Rollen kommen aus ChurchTools', async (t) => {
  const s = setup(t);
  const { agent } = await admin(s);
  alleSchritteErledigen(s);
  const seite = await agent.get('/admin/ersteinrichtung');
  const karte = seite.text.slice(seite.text.indexOf('id="schritt-rollen"'), seite.text.indexOf('id="schritt-churchtools"'));
  assert.match(karte, /Superadmins:<\/strong>[^<]*Anna Admin/);
  assert.match(karte, /Manager:<\/strong>[^<]*Max Manager/);
  assert.match(karte, /Die Rollen werden in ChurchTools über die Gruppenmitgliedschaft vergeben, nicht im Portal\./);
  assert.ok(!karte.includes('anna@x.ch') && !karte.includes('max@x.ch'));
});

test('Schritt mail verweist auf die Zeile Mailserver der technischen Grundlagen', async (t) => {
  const s = setup(t);
  const { agent } = await admin(s);
  const seite = await agent.get('/admin/ersteinrichtung');
  assert.match(seite.text, /id="technik-mailserver"/);
  const mailKarte = seite.text.slice(seite.text.indexOf('id="schritt-mail"'), seite.text.indexOf('id="schritt-konten"'));
  assert.match(mailKarte, /href="\/admin\/ersteinrichtung#technik-mailserver"/);
  assert.doesNotMatch(mailKarte, /href="\/admin\/mail-einstellungen"/);
  for (const g of GEHEIM) assert.ok(!seite.text.includes(g));
  assert.ok(!seite.text.includes('smtp.example.org'));
});

test('POST als Manager ist 403 (spaeter, jobs)', async (t) => {
  const s = setup(t);
  const { agent: m } = await loginAs(s, { gruppen: ['30'] });
  // Eigener, gültiger CSRF-Token des Managers: die 403 kommt von der Rollenprüfung, nicht von CSRF.
  const token = await fetchCsrfToken(m, '/admin');
  for (const pfad of ['/spaeter', '/jobs']) {
    const res = await m.post(`/admin/ersteinrichtung${pfad}`).type('form').send({ _csrf: token });
    assert.equal(res.status, 403, pfad);
  }
  assert.equal(audit(s.db, 'test_jobs').length, 0);
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM admin_config WHERE key LIKE 'einrichtung_spaeter_bis_%'").get().n, 0);
});
