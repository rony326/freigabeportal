import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../../src/db/index.js';
import { getConfigValue, setConfigValue } from '../../../src/db/adminConfigRepo.js';
import { setBerechtigungenForPerson } from '../../../src/db/personBerechtigungenRepo.js';
import { createApp } from '../../../src/app.js';
import { setupMockChurchTools } from '../../helpers/mockChurchTools.js';
import { fetchCsrfToken } from '../../helpers/csrf.js';
import { pruefeAlleDienste } from '../../../src/services/statusPruefungen.js';

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
  };
  const gesendet = [];
  const mailer = { async sendMail(m) { gesendet.push(m); } };
  const app = createApp({ db, config, mailer });
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
  assert.match(seite.text, /sync-personen/);
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
