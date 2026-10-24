import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupMockChurchTools } from '../helpers/mockChurchTools.js';
import { openDatabase } from '../../src/db/index.js';
import { createApp } from '../../src/app.js';
import { setConfigValue, seedDefaults } from '../../src/db/adminConfigRepo.js';

function testConfig() {
  return {
    sessionSecret: 'test-secret', env: 'test', publicBaseUrl: 'http://portal.example.org',
    churchtools: { baseUrl: 'https://ct.example.org', clientId: 'c', clientSecret: 's', redirectUri: 'https://portal.example.org/auth/callback', groupIdBuchhaltung: '10', groupIdAdmin: '20' },
    n8nApiKey: 'k', downloadSigningSecret: 'x', jobsDir: '/tmp/freigabeportal-banner-test-jobs',
  };
}

async function login(db) {
  const config = testConfig();
  const client = setupMockChurchTools(config.churchtools.baseUrl);
  client.intercept({ path: '/oauth/access_token', method: 'POST' }).reply(200, { access_token: 'tok' });
  client.intercept({ path: '/oauth/userinfo', method: 'GET' }).reply(200, { id: 1, firstName: 'Buch', lastName: 'Halter', email: 'b@example.org' });
  client.intercept({ path: '/api/groups/10/members', method: 'GET' }).reply(200, { data: [{ personId: 1 }] });
  client.intercept({ path: '/api/groups/20/members', method: 'GET' }).reply(200, { data: [] });
  const app = createApp({ db, config });
  const agent = request.agent(app);
  const r = await agent.get('/auth/login');
  const state = new URL(r.headers.location).searchParams.get('state');
  await agent.get('/auth/callback').query({ code: 'c', state });
  return { agent, app };
}

function bannerAnlegen(db, art, text, link = null) {
  const von = new Date(Date.now() - 3600e3).toISOString();
  const bis = new Date(Date.now() + 3600e3).toISOString();
  return db.prepare('INSERT INTO banner (art, text, link, von, bis) VALUES (?, ?, ?, ?, ?)').run(art, text, link, von, bis).lastInsertRowid;
}
const csrf = (html) => html.match(/name="_csrf" value="([^"]+)"/)?.[1];

test('Banner: Text escaped, Zeilenumbruch erhalten, wegklickbar nur bei Info', async () => {
  const db = openDatabase(':memory:');
  db.exec('DELETE FROM banner');
  const info = bannerAnlegen(db, 'info', '<script>alert(1)</script>\nZeile 2', '/datenschutz');
  bannerAnlegen(db, 'wartung', 'Wartung heute');
  const { agent } = await login(db);
  const res = await agent.get('/pool');
  assert.doesNotMatch(res.text, /<script>alert\(1\)/);
  assert.match(res.text, /&lt;script&gt;alert\(1\)&lt;\/script&gt;\nZeile 2/);
  assert.match(res.text, new RegExp(`/banner/${info}/ausblenden`));
  assert.equal(res.text.split('/ausblenden').length - 1, 1);
  assert.ok(res.text.indexOf('Wartung heute') < res.text.indexOf('Zeile 2'));
  db.close();
});

test('Info ausblenden: Rücksprung auf die Seite (ohne Referer), danach weg; Wartung -> 400', async () => {
  const db = openDatabase(':memory:');
  db.exec('DELETE FROM banner');
  const info = bannerAnlegen(db, 'info', 'Hinweis eins');
  const wartung = bannerAnlegen(db, 'wartung', 'Wartung zwei');
  const { agent } = await login(db);
  const page = await agent.get('/pool');
  const token = csrf(page.text);
  const bad = await agent.post(`/banner/${wartung}/ausblenden`).type('form').send({ _csrf: token });
  assert.equal(bad.status, 400);
  for (const zurueck of ['https://evil.org/x', '//evil.org/x', '/\\evil.org', '/ferienmodus?x=1', undefined]) {
    const fremd = await agent.post(`/banner/${info}/ausblenden`).type('form').send({ _csrf: token, zurueck });
    assert.equal(fremd.status, 302);
    assert.equal(fremd.headers.location, '/pool', String(zurueck));
    db.exec('DELETE FROM banner_ausgeblendet');
  }
  // Wie im Browser: das Formular der Seite trägt den eigenen Pfad im versteckten Feld.
  const seite = await agent.get('/ferienmodus');
  const zurueck = seite.text.match(new RegExp(`action="/banner/${info}/ausblenden"[\\s\\S]*?name="zurueck" value="([^"]*)"`))?.[1];
  assert.equal(zurueck, '/ferienmodus');
  const res = await agent.post(`/banner/${info}/ausblenden`).type('form').send({ _csrf: csrf(seite.text), zurueck });
  assert.equal(res.headers.location, '/ferienmodus');
  const danach = await agent.get('/pool');
  assert.doesNotMatch(danach.text, /Hinweis eins/);
  assert.match(danach.text, /Wartung zwei/);
  db.close();
});

test('keine Banner auf der Login-Seite', async () => {
  const db = openDatabase(':memory:');
  bannerAnlegen(db, 'warnung', 'Sichtbar nur innen');
  const app = createApp({ db, config: testConfig() });
  const res = await request(app).get('/audit-pruefen');
  assert.doesNotMatch(res.text, /Sichtbar nur innen/);
  db.close();
});

test('Datenschutzseite zeigt Text; ohne Login nicht erreichbar', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  const { agent, app } = await login(db);
  const res = await agent.get('/datenschutz');
  assert.equal(res.status, 200);
  assert.match(res.text, /Seitenaufrufe/);
  assert.match(res.text, /90 Tage/);
  assert.match(res.text, /Betrieb &amp; Nutzung/);
  assert.match(res.text, /die Portal-Administration/);
  setConfigValue(db, 'betrieb_kontakt_email', 'it@example.org');
  setConfigValue(db, 'datenschutz_text', 'Eigener <b>Text</b>\nKontakt: %kontakt%');
  const res2 = await agent.get('/datenschutz');
  assert.match(res2.text, /Eigener &lt;b&gt;Text&lt;\/b&gt;\nKontakt: it@example.org/);
  assert.notEqual((await request(app).get('/datenschutz')).status, 200);
  db.close();
});
