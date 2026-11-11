// Die harten Rollengatter der Admin-Seiten sind durch Rechte ersetzt: jede Seite verlangt genau
// ihr eigenes Recht, vergeben über die Gruppe (gruppen_berechtigungen).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../../src/db/index.js';
import { createApp } from '../../../src/app.js';
import { setupMockChurchTools } from '../../helpers/mockChurchTools.js';
import { setGruppenBerechtigungen } from '../../../src/db/gruppenBerechtigungenRepo.js';

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


const SEITEN = [
  ['benachrichtigungen_verwalten', '/admin/benachrichtigungen/reminder'],
  ['erscheinungsbild_verwalten', '/admin/erscheinungsbild'],
  ['ersteinrichtung_verwalten', '/admin/ersteinrichtung'],
  ['zeitstempel_verwalten', '/admin/zeitstempel'],
  ['personen_einsehen', '/admin/personen'],
  ['backup_verwalten', '/admin/backup'],
  ['module_verwalten', '/admin/module'],
  ['dateiquarantaene_verwalten', '/admin/dateiquarantaene'],
  ['gruppenrechte_verwalten', '/admin/gruppenrechte'],
];

test('Buchhaltung mit genau einem Gruppenrecht erreicht genau die zugehörige Seite', async () => {
  const db = openDatabase(':memory:');
  const brandingDir = mkdtempSync(join(tmpdir(), 'branding-test-'));
  const config = testConfig(brandingDir);
  const app = createApp({ db, config });
  const client = setupMockChurchTools(config.churchtools.baseUrl);
  const agent = await loginAs(app, client, { id: 77, vorname: 'Buch', nachname: 'Halter', email: 'b@example.org', gruppen: ['10'] });

  for (const [recht, pfad] of SEITEN) {
    if (recht === 'gruppenrechte_verwalten') continue; // fest nur für Superadmin, nicht vergebbar
    setGruppenBerechtigungen(db, 'buchhaltung', [recht]);
    const erlaubt = await agent.get(pfad);
    assert.notEqual(erlaubt.status, 403, `${pfad} muss mit ${recht} erreichbar sein`);
    assert.equal(erlaubt.status < 500, true, `${pfad}: ${erlaubt.status}`);
    setGruppenBerechtigungen(db, 'buchhaltung', ['mails_einsehen']);
    const verweigert = await agent.get(pfad);
    assert.equal(verweigert.status, 403, `${pfad} muss ohne ${recht} gesperrt sein`);
  }
  setGruppenBerechtigungen(db, 'buchhaltung', ['mails_einsehen']);
  assert.equal((await agent.get('/admin/gruppenrechte')).status, 403, 'Gruppenrechte nie über Buchhaltung');

  db.close();
  rmSync(brandingDir, { recursive: true, force: true });
});

test('Superadmin ohne backup_verwalten ist auf /admin/backup gesperrt, behält aber Gruppenrechte', async () => {
  const db = openDatabase(':memory:');
  const brandingDir = mkdtempSync(join(tmpdir(), 'branding-test-'));
  const config = testConfig(brandingDir);
  const app = createApp({ db, config });
  const client = setupMockChurchTools(config.churchtools.baseUrl);
  const agent = await loginAs(app, client, { id: 99, vorname: 'Admina', nachname: 'Portal', email: 'a@example.org', gruppen: ['20'] });

  assert.notEqual((await agent.get('/admin/backup')).status, 403);
  setGruppenBerechtigungen(db, 'superadmin', ['konten_verwalten']);
  assert.equal((await agent.get('/admin/backup')).status, 403);
  assert.equal((await agent.get('/admin/gruppenrechte')).status, 200);

  db.close();
  rmSync(brandingDir, { recursive: true, force: true });
});

test('Manager behält nach den Startwerten Personen, aber nicht Backup', async () => {
  const db = openDatabase(':memory:');
  const brandingDir = mkdtempSync(join(tmpdir(), 'branding-test-'));
  const config = testConfig(brandingDir);
  const app = createApp({ db, config });
  const client = setupMockChurchTools(config.churchtools.baseUrl);
  const agent = await loginAs(app, client, { id: 55, vorname: 'Mana', nachname: 'Ger', email: 'm@example.org', gruppen: ['30'] });

  assert.equal((await agent.get('/admin/personen')).status, 200);
  assert.equal((await agent.get('/admin/backup')).status, 403);
  assert.equal((await agent.get('/admin/module')).status, 403);

  db.close();
  rmSync(brandingDir, { recursive: true, force: true });
});
