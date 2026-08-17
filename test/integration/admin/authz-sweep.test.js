// test/integration/admin/authz-sweep.test.js
//
// Proves the REAL createApp({ db, config }) object graph enforces the
// portal-admin guard on every /admin/* route — not a hand-built test app
// that mounts requireRole itself. src/app.js mounts a single blanket
// `app.use('/admin', requireRole(config, 'portal-admin'))` in front of all
// six admin router families; this test sweeps every known route/method
// combination across all six families against the real app and confirms
// each returns 401 when no session/cookie is present at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../../src/db/index.js';
import { createApp } from '../../../src/app.js';

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
  // pdf-einstellungen (2)
  { method: 'get', path: '/admin/pdf-einstellungen' },
  { method: 'post', path: '/admin/pdf-einstellungen' },
  // mails (2)
  { method: 'get', path: '/admin/mails' },
  { method: 'post', path: '/admin/mails/1/erneut-versenden' },
  // abgelehnt (3)
  { method: 'get', path: '/admin/abgelehnt' },
  { method: 'get', path: '/admin/abgelehnt/1' },
  { method: 'post', path: '/admin/abgelehnt/1/loeschen' },
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
