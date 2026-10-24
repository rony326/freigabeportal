import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { openDatabase } from '../../src/db/index.js';
import { seedDefaults } from '../../src/db/adminConfigRepo.js';
import { createApp } from '../../src/app.js';
import { nutzungErfassen } from '../../src/middleware/nutzungErfassen.js';
import { setupMockChurchTools } from '../helpers/mockChurchTools.js';
import { extractCookieValue } from '../helpers/csrf.js';

const UA_FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0';

function testConfig() {
  return {
    sessionSecret: 'test-secret',
    env: 'test',
    churchtools: {
      baseUrl: 'https://ct.example.org',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri: 'https://portal.example.org/auth/callback',
      groupIdBuchhaltung: '10',
      groupIdAdmin: '20',
      syncServiceToken: 'token',
    },
    cronSecret: 'cron-secret',
    n8nApiKey: 'n8n-key',
    downloadSigningSecret: 'download-secret',
  };
}

async function loginAs(app, client, { id, gruppen = [] }) {
  client.intercept({ path: '/oauth/access_token', method: 'POST' }).reply(200, { access_token: `tok-${id}` });
  client.intercept({ path: '/oauth/userinfo', method: 'GET' }).reply(200, { id, firstName: 'Vor', lastName: 'Name', email: `p${id}@example.org` });
  client.intercept({ path: '/api/groups/10/members', method: 'GET' }).reply(200, { data: gruppen.includes('10') ? [{ personId: id }] : [] });
  client.intercept({ path: '/api/groups/20/members', method: 'GET' }).reply(200, { data: gruppen.includes('20') ? [{ personId: id }] : [] });
  const agent = request.agent(app);
  const loginRes = await agent.get('/auth/login');
  const state = new URL(loginRes.headers.location).searchParams.get('state');
  const callbackRes = await agent.get('/auth/callback').query({ code: `code-${id}`, state });
  assert.equal(callbackRes.status, 302);
  return agent;
}

function setup() {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  const client = setupMockChurchTools('https://ct.example.org');
  const app = createApp({ db, config: testConfig() });
  return { db, client, app };
}

function aufrufe(db) {
  return db.prepare('SELECT * FROM nutzung_seitenaufrufe ORDER BY id').all();
}

test('Seitenaufruf angemeldet erfasst, abgemeldet nicht; kein Query-String', async () => {
  const { db, client, app } = setup();
  await request(app).get('/auth/login');
  await request(app).get('/does-not-exist');
  assert.equal(aufrufe(db).length, 0, 'anonyme Aufrufe werden nicht erfasst');

  const agent = await loginAs(app, client, { id: '42' });
  const res = await agent.get('/pool?suche=geheim').set('User-Agent', UA_FIREFOX);
  assert.equal(res.status, 200);
  const rows = aufrufe(db);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.person_id, '42');
  assert.equal(row.methode, 'GET');
  assert.equal(row.pfad, '/pool');
  assert.equal(row.pfad_muster, '/pool');
  assert.equal(row.status, 200);
  assert.ok(Number.isInteger(row.dauer_ms) && row.dauer_ms >= 0);
  assert.equal(row.geraet_typ, 'desktop');
  assert.equal(row.browser, 'Firefox 131');
  assert.equal(row.betriebssystem, 'Linux');
  assert.equal(row.request_id, res.headers['x-request-id']);
  assert.match(row.geraet_id, /^[0-9a-f]{32}$/);
  assert.doesNotMatch(JSON.stringify(row), /geheim/);

  await agent.get('/kontierung/123/aufsplitten?x=1');
  const zweiter = aufrufe(db)[1];
  assert.equal(zweiter.pfad, '/kontierung/123/aufsplitten');
  assert.equal(zweiter.pfad_muster, '/kontierung/:id/aufsplitten');
  db.close();
});

test('Geräte-Cookie gesetzt und wiederverwendet, Gerät mit zuletzt_am geführt', async () => {
  const { db, client, app } = setup();
  const agent = await loginAs(app, client, { id: '42' });
  // Das Cookie wird schon beim Login gesetzt (Anmeldungs-Erfassung); der Seitenaufruf übernimmt es.
  const erste = await agent.get('/pool').set('User-Agent', UA_FIREFOX);
  assert.equal(extractCookieValue(erste.headers, 'fp_geraet'), null, 'gültiges Cookie wird nicht neu gesetzt');
  const geraetId = aufrufe(db)[0].geraet_id;
  assert.match(geraetId, /^[0-9a-f]{32}$/);

  const zweite = await agent.get('/pool').set('User-Agent', UA_FIREFOX);
  assert.equal(extractCookieValue(zweite.headers, 'fp_geraet'), null, 'gültiges Cookie wird nicht neu gesetzt');
  const rows = aufrufe(db);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.geraet_id === geraetId));

  const geraete = db.prepare('SELECT * FROM nutzung_geraete').all();
  assert.equal(geraete.length, 1);
  assert.equal(geraete[0].geraet_id, geraetId);
  assert.equal(geraete[0].person_id, '42');
  assert.equal(geraete[0].user_agent, UA_FIREFOX);
  assert.equal(geraete[0].browser, 'Firefox 131');
  assert.ok(geraete[0].erstmals_am <= geraete[0].zuletzt_am);
  db.close();
});

test('Geräte-Cookie ist Secure, wenn die Session-Cookies Secure sind', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  const client = setupMockChurchTools('https://ct.example.org');
  const app = createApp({ db, config: { ...testConfig(), publicBaseUrl: 'https://portal.example.org' } });
  // Secure-Session-Cookies werden über http nicht zurückgeschickt: Anmeldung per manuell
  // weitergereichtem Cookie-Header.
  client.intercept({ path: '/oauth/access_token', method: 'POST' }).reply(200, { access_token: 'tok' });
  client.intercept({ path: '/oauth/userinfo', method: 'GET' }).reply(200, { id: '5', firstName: 'A', lastName: 'B', email: 'a@example.org' });
  client.intercept({ path: '/api/groups/10/members', method: 'GET' }).reply(200, { data: [] });
  client.intercept({ path: '/api/groups/20/members', method: 'GET' }).reply(200, { data: [] });
  const loginRes = await request(app).get('/auth/login').set('X-Forwarded-Proto', 'https');
  const cookies1 = [].concat(loginRes.headers['set-cookie'] || []).map((c) => c.split(';')[0]);
  const state = new URL(loginRes.headers.location).searchParams.get('state');
  const cb = await request(app).get('/auth/callback').query({ code: 'c', state }).set('X-Forwarded-Proto', 'https').set('Cookie', cookies1.join('; '));
  assert.equal(cb.status, 302);
  const sid = [].concat(cb.headers['set-cookie']).map((c) => c.split(';')[0]).find((c) => c.startsWith('connect.sid='));
  const res = await request(app).get('/pool').set('X-Forwarded-Proto', 'https').set('Cookie', sid);
  assert.equal(res.status, 200);
  const header = [].concat(res.headers['set-cookie']).find((c) => c.startsWith('fp_geraet='));
  assert.match(header, /Secure/);
  db.close();
});

test('Erfassen scheitert still und meldet höchstens einmal', async (t) => {
  const { db, client, app } = setup();
  const agent = await loginAs(app, client, { id: '42' });
  db.exec('DROP TABLE nutzung_seitenaufrufe');
  const fehler = t.mock.method(console, 'error', () => {});
  assert.equal((await agent.get('/pool')).status, 200);
  assert.equal((await agent.get('/pool')).status, 200);
  assert.equal(fehler.mock.callCount(), 1);
  db.close();
});

function miniApp(db, { angemeldet = true } = {}) {
  const app = express();
  app.use(cookieParser());
  app.use((req, res, next) => {
    req.session = { cookie: { secure: false } };
    req.currentPerson = angemeldet ? { churchtools_person_id: '9' } : null;
    next();
  });
  app.use(nutzungErfassen(db));
  app.get('/json', (req, res) => res.json({ ok: true }));
  app.post('/formular', (req, res) => res.redirect('/seite'));
  app.use((req, res) => res.type('html').send('<p>ok</p>'));
  return app;
}

test('ausgenommene Präfixe, statische Assets und Nicht-HTML-Antworten werden nicht erfasst', async () => {
  const db = openDatabase(':memory:');
  const app = miniApp(db);
  for (const pfad of ['/api/n8n/jobs', '/internal/cron/x', '/branding/logo', '/downloads/abc', '/css/app.css', '/js/app.js', '/json']) {
    await request(app).get(pfad);
  }
  assert.equal(aufrufe(db).length, 0);
  await request(app).get('/seite');
  assert.equal(aufrufe(db).length, 1);
  assert.equal(aufrufe(db)[0].person_id, '9');
  db.close();
});

test('ohne angemeldete Person wird kein Geräte-Cookie gesetzt', async () => {
  const db = openDatabase(':memory:');
  const res = await request(miniApp(db, { angemeldet: false })).get('/seite');
  assert.equal(extractCookieValue(res.headers, 'fp_geraet'), null);
  assert.equal(aufrufe(db).length, 0);
  db.close();
});

test('Weiterleitungen (z.B. nach Formular-POST) werden nicht erfasst', async () => {
  const db = openDatabase(':memory:');
  const res = await request(miniApp(db)).post('/formular').set('Accept', 'text/html');
  assert.equal(res.status, 302);
  assert.match(res.headers['content-type'], /text\/html/);
  assert.equal(aufrufe(db).length, 0);
  db.close();
});
