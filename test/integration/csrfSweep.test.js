// Proves the REAL createApp({ db, config }) object graph enforces CSRF protection
// (src/middleware/csrf.js) on every session-authenticated POST route — not a hand-built test app
// that mounts csrfProtection itself. Mirrors test/integration/admin/authz-sweep.test.js's
// approach: a single logged-in person with every role/permission needed to clear each route's
// authorization gate, then a sweep proving CSRF is checked before that route's own business
// logic even runs (a missing/invalid token is rejected with the dedicated 403 CSRF error page,
// not a resource-specific 404/400/403). n8n and cron routes (API-key/secret authenticated, no
// session) must stay exempt — swept separately to prove that.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createApp } from '../../src/app.js';
import { setupMockChurchTools } from '../helpers/mockChurchTools.js';
import { fetchCsrfToken } from '../helpers/csrf.js';

function testConfig(dir) {
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
    smtp: { host: 'smtp.example.org', port: 587, user: 'user', pass: 'pass', from: 'portal@example.org' },
    brandingDir: dir,
    jobsDir: dir,
    backupDir: dir,
    downloadSigningSecret: 'download-secret',
  };
}

async function loginAs(app, client, { id, vorname, nachname, email, gruppen }) {
  client.intercept({ path: '/oauth/access_token', method: 'POST' }).reply(200, { access_token: `tok-${id}` });
  client.intercept({ path: '/oauth/userinfo', method: 'GET' }).reply(200, { id, firstName: vorname, lastName: nachname, email });
  client.intercept({ path: '/api/groups/10/members', method: 'GET' }).reply(200, { data: gruppen.includes('10') ? [{ personId: id }] : [] });
  client.intercept({ path: '/api/groups/20/members', method: 'GET' }).reply(200, { data: gruppen.includes('20') ? [{ personId: id }] : [] });

  const agent = request.agent(app);
  const loginRes = await agent.get('/auth/login');
  const state = new URL(loginRes.headers.location).searchParams.get('state');
  const callbackRes = await agent.get('/auth/callback').query({ code: `code-${id}`, state });
  assert.equal(callbackRes.status, 302, `login for person ${id} should succeed`);
  return agent;
}

// Every router.post route across the app that sits behind a session (not machine) gate. IDs are
// placeholders (a resource lookup never happens — CSRF is checked before any of that).
const SESSION_POST_ROUTES = [
  '/auth/logout',
  '/api/pool/1/beanspruchen',
  '/kontierung/lieferanten',
  '/kontierung/1',
  '/kontierung/1/zurueck-in-pool',
  '/kontierung/1/aufsplitten',
  '/freigabe2/1',
  '/abgelehnt/1/ueberarbeiten',
  '/zeitstempel-pruefen',
  '/admin/konten',
  '/admin/konten/1',
  '/admin/konten/1/deaktivieren',
  '/admin/konten/1/aktivieren',
  '/admin/debitoren',
  '/admin/debitoren/regeln',
  '/admin/debitoren/regeln/1',
  '/admin/debitoren/regeln/1/loeschen',
  '/admin/debitoren/ibans',
  '/admin/debitoren/ibans/1/loeschen',
  '/admin/debitoren/1',
  '/admin/debitoren/1/deaktivieren',
  '/admin/debitoren/1/aktivieren',
  '/admin/eskalation',
  '/admin/erscheinungsbild',
  '/admin/zeitstempel',
  '/admin/personen/1/berechtigungen',
  '/admin/mails/1/erneut-versenden',
  '/admin/sync',
  '/admin/sync/stalled/1/freigeben',
  '/admin/abgelehnt/1/loeschen',
  '/admin/geplante-jobs',
  '/admin/geplante-jobs/sync-personen/jetzt-ausfuehren',
  '/admin/geplante-jobs/pool-erinnerungen/jetzt-ausfuehren',
  '/admin/geplante-jobs/pdf-bereinigung/jetzt-ausfuehren',
  '/admin/geplante-jobs/zeitstempel-nachholen/jetzt-ausfuehren',
  '/admin/geplante-jobs/split-gruppen-nachholen/jetzt-ausfuehren',
  '/admin/backup',
  '/admin/backup/jetzt-ausfuehren',
  '/admin/backup/dateien/x.zip/loeschen',
  '/admin/backup/wiederherstellen',
];

test('the real createApp wiring rejects every session-authenticated POST route with no CSRF token, via the dedicated CSRF error page', async () => {
  assert.equal(SESSION_POST_ROUTES.length, 40, 'sanity check: this sweep should cover exactly 40 routes');

  const db = openDatabase(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'csrf-sweep-test-'));
  const config = testConfig(dir);
  const app = createApp({ db, config });
  const client = setupMockChurchTools(config.churchtools.baseUrl);

  // superadmin (group 20) + buchhaltung (group 10) clears every route-level gate in front of
  // these routers (requireLogin, requireRole('buchhaltung'), requirePermission/requireRole
  // ('superadmin')) so every POST reaches its router's own CSRF check, not an earlier 401/403.
  const agent = await loginAs(app, client, { id: 1, vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['10', '20'] });

  for (const path of SESSION_POST_ROUTES) {
    // No _csrf field, no x-csrf-token header — and multer no-ops for a non-multipart content
    // type, so this reaches the CSRF check on the multipart routes too (uploadBeleg/uploadBackup
    // never even attempt to parse a body that isn't multipart/form-data).
    const res = await agent.post(path).type('form').send({});
    assert.equal(res.status, 403, `POST ${path} should be 403 without a CSRF token`);
    assert.match(res.text, /Sicherheitsprüfung fehlgeschlagen/, `POST ${path} should render the dedicated CSRF error page, not a different 403`);
  }

  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('a valid CSRF token (form field) is accepted on a plain session POST route', async () => {
  const db = openDatabase(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'csrf-sweep-valid-test-'));
  const config = testConfig(dir);
  const app = createApp({ db, config });
  const client = setupMockChurchTools(config.churchtools.baseUrl);
  const agent = await loginAs(app, client, { id: 1, vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['10', '20'] });

  const token = await fetchCsrfToken(agent, '/pool');
  // Wrong Konto id -> the route's own 404, proving the request cleared the CSRF gate and reached
  // real business logic instead of being rejected at 403 for a missing/invalid token.
  const res = await agent.post('/admin/konten/999999/deaktivieren').type('form').send({ _csrf: token });
  assert.notEqual(res.status, 403, 'a valid token must not be rejected as a CSRF failure');

  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('a valid CSRF token (x-csrf-token header) is accepted on the fetch()-based AJAX routes', async () => {
  const db = openDatabase(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'csrf-sweep-ajax-test-'));
  const config = testConfig(dir);
  const app = createApp({ db, config });
  const client = setupMockChurchTools(config.churchtools.baseUrl);
  const agent = await loginAs(app, client, { id: 1, vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['10', '20'] });

  const token = await fetchCsrfToken(agent, '/pool');
  const poolRes = await agent.post('/api/pool/999999/beanspruchen').set('x-csrf-token', token);
  assert.notEqual(poolRes.status, 403, 'a valid header token must not be rejected as a CSRF failure');

  const lieferantenRes = await agent.post('/kontierung/lieferanten').set('x-csrf-token', token).type('form').send({ name: 'Test AG' });
  assert.notEqual(lieferantenRes.status, 403, 'a valid header token must not be rejected as a CSRF failure');

  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('n8n and cron machine routes stay exempt from CSRF — no token needed, only their own API key/secret', async () => {
  const db = openDatabase(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'csrf-sweep-machine-test-'));
  const app = createApp({ db, config: testConfig(dir) });

  const jobsRes = await request(app).post('/api/n8n/jobs').set('X-API-Key', 'n8n-key');
  assert.notEqual(jobsRes.status, 403, 'n8n route must not be blocked by CSRF');

  const cronRes = await request(app).post('/internal/cron/sync-personen').set('X-Cron-Secret', 'cron-secret');
  assert.notEqual(cronRes.status, 403, 'cron route must not be blocked by CSRF');

  db.close();
  rmSync(dir, { recursive: true, force: true });
});
