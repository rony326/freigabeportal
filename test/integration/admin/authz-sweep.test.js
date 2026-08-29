// test/integration/admin/authz-sweep.test.js
//
// Proves the REAL createApp({ db, config }) object graph enforces a login
// guard on every /admin/* route — not a hand-built test app that mounts
// requireRole itself. src/app.js mounts a single blanket
// `app.use('/admin', sessionLimiter, requireAdminAreaAccess(db, config))`
// in front of all admin router families — admitting superadmin, manager,
// or anyone with at least one individual Berechtigung, not superadmin
// alone — and each sub-router then applies its own more specific gate
// (requirePermission for the grantable areas, requireRole('superadmin')
// for the three hard-locked ones). This test sweeps every known
// route/method combination across the eight admin router families below
// (konten, debitoren, eskalation, erscheinungsbild, personen, mails,
// abgelehnt, geplante-jobs — zeitstempel and sync are exercised by the
// second test below instead) against the real app and confirms each
// returns 401 when no session/cookie is present at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../../src/db/index.js';
import { createApp } from '../../../src/app.js';
import { setupMockChurchTools } from '../../helpers/mockChurchTools.js';
import { upsertPerson } from '../../../src/db/personenRepo.js';

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

const ADMIN_ROUTES = [
  // konten (6)
  { method: 'get', path: '/admin/konten' },
  { method: 'get', path: '/admin/konten/neu' },
  { method: 'post', path: '/admin/konten' },
  { method: 'get', path: '/admin/konten/1/bearbeiten' },
  { method: 'post', path: '/admin/konten/1' },
  { method: 'post', path: '/admin/konten/1/deaktivieren' },
  // debitoren (9)
  { method: 'get', path: '/admin/debitoren' },
  { method: 'post', path: '/admin/debitoren' },
  { method: 'get', path: '/admin/debitoren/1/bearbeiten' },
  { method: 'post', path: '/admin/debitoren/1' },
  { method: 'post', path: '/admin/debitoren/1/deaktivieren' },
  { method: 'post', path: '/admin/debitoren/regeln' },
  { method: 'get', path: '/admin/debitoren/regeln/1/bearbeiten' },
  { method: 'post', path: '/admin/debitoren/regeln/1' },
  { method: 'post', path: '/admin/debitoren/regeln/1/loeschen' },
  // eskalation (2)
  { method: 'get', path: '/admin/eskalation' },
  { method: 'post', path: '/admin/eskalation' },
  // erscheinungsbild (2)
  { method: 'get', path: '/admin/erscheinungsbild' },
  { method: 'post', path: '/admin/erscheinungsbild' },
  // personen (1)
  { method: 'get', path: '/admin/personen' },
  { method: 'post', path: '/admin/personen/1/berechtigungen' },
  // mails (2)
  { method: 'get', path: '/admin/mails' },
  { method: 'post', path: '/admin/mails/1/erneut-versenden' },
  // abgelehnt (3)
  { method: 'get', path: '/admin/abgelehnt' },
  { method: 'get', path: '/admin/abgelehnt/1' },
  { method: 'post', path: '/admin/abgelehnt/1/loeschen' },
  // audit-log (1)
  { method: 'get', path: '/admin/audit-log' },
  // geplante-jobs (5)
  { method: 'get', path: '/admin/geplante-jobs' },
  { method: 'post', path: '/admin/geplante-jobs' },
  { method: 'post', path: '/admin/geplante-jobs/sync-personen/jetzt-ausfuehren' },
  { method: 'post', path: '/admin/geplante-jobs/pool-erinnerungen/jetzt-ausfuehren' },
  { method: 'post', path: '/admin/geplante-jobs/pdf-bereinigung/jetzt-ausfuehren' },
];

test('the real createApp wiring returns 401 on all 32 admin route/method combinations with no session present', async () => {
  assert.equal(ADMIN_ROUTES.length, 32, 'sanity check: this sweep should cover exactly 32 route/method combinations');

  const db = openDatabase(':memory:');
  const brandingDir = mkdtempSync(join(tmpdir(), 'branding-test-'));
  const app = createApp({ db, config: testConfig(brandingDir) });

  for (const { method, path } of ADMIN_ROUTES) {
    const res = await request(app)[method](path);
    assert.equal(res.status, 401, `${method.toUpperCase()} ${path} should be 401 without a session on the real app`);
  }

  db.close();
  rmSync(brandingDir, { recursive: true, force: true });
});

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

test('the real createApp wiring enforces the superadmin-only hard lock and the manager bundle correctly', async () => {
  const db = openDatabase(':memory:');
  const brandingDir = mkdtempSync(join(tmpdir(), 'branding-test-'));
  const config = testConfig(brandingDir);
  const app = createApp({ db, config });
  const client = setupMockChurchTools(config.churchtools.baseUrl);

  const managerAgent = await loginAs(app, client, { id: 55, vorname: 'Mana', nachname: 'Ger', email: 'manager@example.org', gruppen: ['30'] });

  const HART_GESPERRT = [
    { method: 'get', path: '/admin/eskalation' },
    { method: 'get', path: '/admin/erscheinungsbild' },
    { method: 'get', path: '/admin/zeitstempel' },
  ];
  for (const { method, path } of HART_GESPERRT) {
    const res = await managerAgent[method](path);
    assert.equal(res.status, 403, `${method.toUpperCase()} ${path} must stay superadmin-only even for a Manager`);
  }

  const VERGEBBAR = [
    { method: 'get', path: '/admin/konten' },
    { method: 'get', path: '/admin/debitoren' },
    { method: 'get', path: '/admin/mails' },
    { method: 'get', path: '/admin/sync' },
    { method: 'get', path: '/admin/abgelehnt' },
    { method: 'get', path: '/admin/geplante-jobs' },
    { method: 'get', path: '/admin/audit-log' },
  ];
  for (const { method, path } of VERGEBBAR) {
    const res = await managerAgent[method](path);
    assert.equal(res.status, 200, `${method.toUpperCase()} ${path} must be reachable by a Manager`);
  }

  db.close();
  rmSync(brandingDir, { recursive: true, force: true });
});
