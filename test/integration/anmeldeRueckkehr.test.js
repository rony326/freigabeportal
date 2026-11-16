// U1 (Prüfung 2026-11-15): Rücksprung nach der Anmeldung, 401-Seite, Maschinenrouten bleiben JSON.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupMockChurchTools } from '../helpers/mockChurchTools.js';
import { openDatabase } from '../../src/db/index.js';
import { createApp } from '../../src/app.js';
import { createPublicRateLimiter, createSessionRateLimiter, createMachineRateLimiter } from '../../src/middleware/rateLimit.js';

const HTML = 'text/html,application/xhtml+xml';

function testConfig() {
  return {
    sessionSecret: 'test-secret', env: 'test', publicBaseUrl: 'http://portal.example.org',
    churchtools: { baseUrl: 'https://ct.example.org', clientId: 'c', clientSecret: 's', redirectUri: 'https://portal.example.org/auth/callback', groupIdBuchhaltung: '10', groupIdAdmin: '20' },
    n8nApiKey: 'k', cronSecret: 'cron', downloadSigningSecret: 'x', jobsDir: '/tmp/freigabeportal-rueckkehr-test-jobs',
  };
}

function mockLogin(config) {
  const client = setupMockChurchTools(config.churchtools.baseUrl);
  client.intercept({ path: '/oauth/access_token', method: 'POST' }).reply(200, { access_token: 'tok' });
  client.intercept({ path: '/oauth/userinfo', method: 'GET' }).reply(200, { id: 1, firstName: 'Buch', lastName: 'Halter', email: 'b@example.org' });
  client.intercept({ path: '/api/groups/10/members', method: 'GET' }).reply(200, { data: [{ personId: 1 }] });
  client.intercept({ path: '/api/groups/20/members', method: 'GET' }).reply(200, { data: [] });
}

// Führt /auth/login + /auth/callback aus und liefert die Callback-Antwort.
async function anmelden(agent, config) {
  mockLogin(config);
  const r = await agent.get('/auth/login');
  const state = new URL(r.headers.location).searchParams.get('state');
  return agent.get('/auth/callback').query({ code: 'c', state });
}

function neu() {
  const db = openDatabase(':memory:');
  const config = testConfig();
  return { db, config, agent: request.agent(createApp({ db, config })) };
}

test('U1: GET einer geschützten Seite ohne Sitzung leitet zur Anmeldung, nach dem Login geht es zurück', async () => {
  const { db, config, agent } = neu();
  const res = await agent.get('/kontierung/123').set('Accept', HTML);
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/auth/login');
  const cb = await anmelden(agent, config);
  assert.equal(cb.status, 302);
  assert.equal(cb.headers.location, '/kontierung/123');
  // Das Ziel ist verbraucht: eine zweite Anmeldung landet wieder im Dashboard.
  const zweite = await anmelden(agent, config);
  assert.equal(zweite.headers.location, '/pool');
  db.close();
});

test('U1: die Query (jobId) bleibt erhalten', async () => {
  const { db, config, agent } = neu();
  await agent.get('/zeitstempel-pruefen?jobId=5').set('Accept', HTML);
  const cb = await anmelden(agent, config);
  assert.equal(cb.headers.location, '/zeitstempel-pruefen?jobId=5');
  db.close();
});

test('U1: 401-Seite (ohne Rücksprung) zeigt Überschrift und Anmelden-Knopf', async () => {
  const { db, agent } = neu();
  const res = await agent.post('/kontierung/123/freigeben').type('form').send({}).set('Accept', HTML);
  assert.equal(res.status, 401);
  assert.match(res.text, /Bitte melde dich an/);
  assert.match(res.text, /href="\/auth\/login"[^>]*>Anmelden</);
  assert.match(res.text, /abgelaufen/);
  db.close();
});

test('U1: POST wird nie umgeleitet und merkt kein Ziel', async () => {
  const { db, config, agent } = neu();
  const res = await agent.post('/kontierung/123/freigeben').type('form').send({}).set('Accept', HTML);
  assert.equal(res.status, 401);
  const cb = await anmelden(agent, config);
  assert.equal(cb.headers.location, '/pool');
  db.close();
});

test('U1: Download-/Dateiziele werden nicht gemerkt (401-Seite mit Knopf statt Umleitung)', async () => {
  const { db, config, agent } = neu();
  const res = await agent.get('/downloads/1/oeffnen').set('Accept', HTML);
  assert.equal(res.status, 401);
  assert.match(res.text, /href="\/auth\/login"/);
  const cb = await anmelden(agent, config);
  assert.equal(cb.headers.location, '/pool');
  db.close();
});

test('U1: GET ohne Accept text/html (fetch, Skripte) bekommt weiter 401 statt Umleitung', async () => {
  const { db, agent } = neu();
  const res = await agent.get('/kontierung/123');
  assert.equal(res.status, 401);
  db.close();
});

test('U1: Maschinen- und JSON-Routen antworten weiter mit 401 JSON', async () => {
  const { db, agent } = neu();
  for (const [methode, pfad] of [['get', '/downloads/1/refresh-url'], ['get', '/downloads/1/thumbnail'], ['post', '/api/pool/1/beanspruchen'], ['get', '/api/n8n/jobs/abholbereit'], ['post', '/api/n8n/jobs'], ['post', '/internal/cron/reminder']]) {
    const res = await agent[methode](pfad).set('Accept', '*/*');
    assert.equal(res.status, 401, `${methode} ${pfad}`);
    assert.match(res.headers['content-type'], /application\/json/, `${methode} ${pfad} muss JSON liefern`);
    assert.equal(res.headers.location, undefined, `${pfad} darf nicht umleiten`);
  }
  // Auch mit Accept text/html bleiben die Schlüssel-Routen JSON (kein Browser-Ziel).
  const n8n = await agent.get('/api/n8n/jobs/abholbereit').set('Accept', HTML);
  assert.equal(n8n.status, 401);
  assert.match(n8n.headers['content-type'], /application\/json/);
  db.close();
});

test('U1: ein manipuliertes Ziel in der Vor-Login-Sitzung wird nach dem Login nochmals geprüft', async () => {
  const { db, config, agent } = neu();
  await agent.get('/kontierung/123').set('Accept', HTML);
  mockLogin(config);
  const r = await agent.get('/auth/login');
  const state = new URL(r.headers.location).searchParams.get('state');
  // Sitzung in der Datenbank verfälschen (so, als hätte jemand ein fremdes Ziel einschleusen können).
  const zeile = db.prepare('SELECT sid, sess FROM sessions').get();
  const sess = JSON.parse(zeile.sess);
  sess.rueckkehr = '//evil.example.org/x';
  db.prepare('UPDATE sessions SET sess = ? WHERE sid = ?').run(JSON.stringify(sess), zeile.sid);
  const cb = await agent.get('/auth/callback').query({ code: 'c', state });
  assert.equal(cb.status, 302);
  assert.equal(cb.headers.location, '/pool');
  db.close();
});

test('U1: das Ziel gehört nicht in die neue Sitzung, und die Sitzungs-ID wechselt (Fixation)', async () => {
  const { db, config, agent } = neu();
  await agent.get('/kontierung/123').set('Accept', HTML);
  const vorher = db.prepare('SELECT sid FROM sessions').get().sid;
  await anmelden(agent, config);
  const zeilen = db.prepare('SELECT sid, sess FROM sessions').all();
  assert.equal(zeilen.length, 1);
  assert.notEqual(zeilen[0].sid, vorher);
  assert.equal(JSON.parse(zeilen[0].sess).rueckkehr, undefined);
  assert.equal(JSON.parse(zeilen[0].sess).personId, '1');
  db.close();
});

test('U1: Abmelden → Bestätigungsseite leitet nicht automatisch wieder an (keine SSO-Schleife)', async () => {
  const { db, config, agent } = neu();
  await anmelden(agent, config);
  const token = (await agent.get('/pool')).text.match(/name="_csrf" value="([^"]+)"/)[1];
  const aus = await agent.post('/auth/logout').type('form').send({ _csrf: token });
  assert.equal(aus.status, 302);
  assert.equal(aus.headers.location, '/auth/abgemeldet');
  const seite = await agent.get('/auth/abgemeldet').set('Accept', HTML);
  assert.equal(seite.status, 200);
  assert.match(seite.text, /Du wurdest abgemeldet/);
  // Die Abmeldung hinterlässt kein Rücksprungziel.
  const cb = await anmelden(agent, config);
  assert.equal(cb.headers.location, '/pool');
  db.close();
});

test('U1: inaktive Person (Sitzung vorhanden) bekommt die 401-Seite, keine Umleitungsschleife', async () => {
  const { db, config, agent } = neu();
  await anmelden(agent, config);
  db.prepare('UPDATE personen SET aktiv = 0').run();
  const res = await agent.get('/pool').set('Accept', HTML);
  assert.equal(res.status, 401);
  assert.equal(res.headers.location, undefined);
  assert.match(res.text, /href="\/auth\/login"/);
  db.close();
});
