import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../../src/db/index.js';
import { createApp } from '../../../src/app.js';
import { setupMockChurchTools } from '../../helpers/mockChurchTools.js';
import { fetchCsrfToken } from '../../helpers/csrf.js';
import { istWartungsmodusAktiv, wartungsHinweis, setzeWartungsmodus } from '../../../src/services/wartungsmodus.js';

function testConfig(brandingDir) {
  return {
    sessionSecret: 'test-secret',
    env: 'test',
    churchtools: {
      baseUrl: 'https://ct.example.org',
      clientId: 'id',
      clientSecret: 'secret',
      redirectUri: 'https://portal.example.org/auth/callback',
      groupIdBuchhaltung: '10',
      groupIdAdmin: '20',
      groupIdManager: '30',
      syncServiceToken: 'token',
    },
    cronSecret: 'cron-secret',
    n8nApiKey: 'n8n-key',
    smtp: { host: 'smtp.example.org', port: 587, user: 'user', pass: 'pass', from: 'portal@example.org' },
    brandingDir,
  };
}

async function loginAs(app, client, { id, vorname, nachname, email, gruppen }) {
  client.intercept({ path: '/oauth/access_token', method: 'POST' }).reply(200, { access_token: `tok-${id}` });
  client.intercept({ path: '/oauth/userinfo', method: 'GET' }).reply(200, { id, firstName: vorname, lastName: nachname, email });
  client
    .intercept({ path: '/api/groups/10/members', method: 'GET' })
    .reply(200, { data: gruppen.includes('10') ? [{ personId: id }] : [] });
  client
    .intercept({ path: '/api/groups/20/members', method: 'GET' })
    .reply(200, { data: gruppen.includes('20') ? [{ personId: id }] : [] });
  client
    .intercept({ path: '/api/groups/30/members', method: 'GET' })
    .reply(200, { data: gruppen.includes('30') ? [{ personId: id }] : [] });

  const agent = request.agent(app);
  const loginRes = await agent.get('/auth/login');
  const state = new URL(loginRes.headers.location).searchParams.get('state');
  const callbackRes = await agent.get('/auth/callback').query({ code: `code-${id}`, state });
  assert.equal(callbackRes.status, 302, `login for person ${id} should succeed`);
  return agent;
}



function setup(t) {
  const db = openDatabase(':memory:');
  const brandingDir = mkdtempSync(join(tmpdir(), 'branding-test-'));
  const config = testConfig(brandingDir);
  const app = createApp({ db, config });
  const client = setupMockChurchTools(config.churchtools.baseUrl);
  t.after(() => { db.close(); rmSync(brandingDir, { recursive: true, force: true }); });
  return { db, app, client };
}

const ADMIN = { id: 99, vorname: 'Admina', nachname: 'Portal', email: 'a@example.org', gruppen: ['20'] };

test('ohne Recht: 403 auf GET und POST (Manager hat es nicht)', async (t) => {
  const { db, app, client } = setup(t);
  const agent = await loginAs(app, client, { id: 55, vorname: 'Mana', nachname: 'Ger', email: 'm@example.org', gruppen: ['30'] });
  assert.equal((await agent.get('/admin/wartungsmodus')).status, 403);
  assert.equal((await agent.post('/admin/wartungsmodus').type('form').send({})).status, 403);
  assert.equal(istWartungsmodusAktiv(db), false);
});

test('Einschalten mit Hinweis, danach Ausschalten; beides im Audit-Log', async (t) => {
  const { db, app, client } = setup(t);
  const agent = await loginAs(app, client, ADMIN);
  let token = await fetchCsrfToken(agent, '/admin/wartungsmodus');
  let res = await agent.post('/admin/wartungsmodus').type('form').send({ _csrf: token, aktion: 'einschalten', hinweis: 'Update bis 14:00' });
  assert.equal(res.status, 302);
  assert.equal(istWartungsmodusAktiv(db), true);
  assert.equal(wartungsHinweis(db), 'Update bis 14:00');

  // Person mit Recht kommt weiter und kann ausschalten
  const seite = await agent.get('/admin/wartungsmodus');
  assert.equal(seite.status, 200);
  assert.match(seite.text, /Wartungsmodus ausschalten/);
  token = await fetchCsrfToken(agent, '/admin/wartungsmodus');
  res = await agent.post('/admin/wartungsmodus').type('form').send({ _csrf: token, aktion: 'ausschalten' });
  assert.equal(res.status, 302);
  assert.equal(istWartungsmodusAktiv(db), false);

  const audit = db.prepare("SELECT objekt_id, person_id FROM audit_ereignisse WHERE objekt = 'admin_config' AND objekt_id = 'wartungsmodus_aktiv' ORDER BY id").all();
  assert.equal(audit.length, 2);
  assert.equal(audit[0].person_id, '99');
});

test('Statusseite im Zustand «aus» bietet Einschalten an', async (t) => {
  const { app, client } = setup(t);
  const agent = await loginAs(app, client, ADMIN);
  const seite = await agent.get('/admin/wartungsmodus');
  assert.equal(seite.status, 200);
  assert.match(seite.text, /Wartungsmodus einschalten/);
  assert.match(seite.text, /name="hinweis"/);
});

test('/healthz meldet den Wartungsmodus als Info, nicht als Fehler', async (t) => {
  const { db, app } = setup(t);
  const { createHash } = await import('node:crypto');
  const { setConfigValue } = await import('../../../src/db/adminConfigRepo.js');
  const key = 'ab'.repeat(32);
  setConfigValue(db, 'monitoring_secret', createHash('sha256').update(key).digest('hex'));
  setzeWartungsmodus(db, true);
  const res = await request(app).get('/healthz').set('X-Monitoring-Key', key);
  assert.equal(res.status, 200);
  assert.equal(res.body.wartungsmodus, true);
  assert.notEqual(res.body.status, 'fehler');
});
