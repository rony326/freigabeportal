import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, utimesSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { openDatabase } from '../../../src/db/index.js';
import { createApp } from '../../../src/app.js';
import { createJob } from '../../../src/db/jobsRepo.js';
import { writeFinalDocument } from '../../../src/services/finalDocument.js';
import { setupMockChurchTools } from '../../helpers/mockChurchTools.js';
import { fetchCsrfToken } from '../../helpers/csrf.js';

function testConfig(dir) {
  return {
    sessionSecret: 'test-secret', env: 'test',
    churchtools: { baseUrl: 'https://ct.example.org', clientId: 'id', clientSecret: 'secret', redirectUri: 'https://portal.example.org/auth/callback', groupIdBuchhaltung: '10', groupIdAdmin: '20', syncServiceToken: 'token' },
    cronSecret: 'cron-secret', n8nApiKey: 'n8n-key',
    smtp: { host: 'smtp.example.org', port: 587, user: 'user', pass: 'pass', from: 'portal@example.org' },
    brandingDir: join(dir, 'branding'), jobsDir: join(dir, 'jobs'), backupDir: join(dir, 'backup'), downloadSigningSecret: 'download-secret',
  };
}

async function loginAs(app, client, id, gruppen) {
  client.intercept({ path: '/oauth/access_token', method: 'POST' }).reply(200, { access_token: `tok-${id}` });
  client.intercept({ path: '/oauth/userinfo', method: 'GET' }).reply(200, { id, firstName: 'P', lastName: String(id), email: `p${id}@example.org` });
  client.intercept({ path: '/api/groups/10/members', method: 'GET' }).reply(200, { data: gruppen.includes('10') ? [{ personId: id }] : [] });
  client.intercept({ path: '/api/groups/20/members', method: 'GET' }).reply(200, { data: gruppen.includes('20') ? [{ personId: id }] : [] });
  const agent = request.agent(app);
  const state = new URL((await agent.get('/auth/login')).headers.location).searchParams.get('state');
  assert.equal((await agent.get('/auth/callback').query({ code: `c-${id}`, state })).status, 302);
  return agent;
}

test('quarantine page and decisions require superadmin, CSRF and a reason; decisions are attributed', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'quarantaene-route-'));
  const db = openDatabase(':memory:');
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const config = testConfig(dir);
  mkdirSync(config.jobsDir, { recursive: true });
  const quelle = join(config.jobsDir, 'job-1.pdf');
  writeFileSync(quelle, '%PDF');
  createJob(db, { eingangAm: '2026-09-29T00:00:00Z', quelle: 'scanner', dateiname: 'a.pdf', pdfPfad: quelle });
  const verwaist = writeFinalDocument(quelle, Buffer.from('%PDF-verwaist'));
  const alt = new Date(Date.now() - 48 * 3600 * 1000);
  utimesSync(verwaist, alt, alt);

  const app = createApp({ db, config });
  const client = setupMockChurchTools(config.churchtools.baseUrl);
  assert.equal((await request(app).get('/admin/dateiquarantaene')).status, 401);
  const buchhaltung = await loginAs(app, client, 5, ['10']);
  assert.equal((await buchhaltung.get('/admin/dateiquarantaene')).status, 403);
  const admin = await loginAs(app, client, 1, ['20']);
  const token = await fetchCsrfToken(admin, '/admin/dateiquarantaene');
  assert.equal((await admin.post('/admin/dateiquarantaene/pruefen').type('form').send({})).status, 403);
  assert.equal(existsSync(verwaist), true);
  assert.equal((await admin.post('/admin/dateiquarantaene/pruefen').type('form').send({ _csrf: token })).status, 302);
  assert.equal(existsSync(verwaist), false);
  const { id } = db.prepare('SELECT id FROM datei_quarantaene').get();
  const seite = await admin.get('/admin/dateiquarantaene');
  assert.match(seite.text, new RegExp(basename(verwaist)));
  assert.equal((await admin.post(`/admin/dateiquarantaene/${id}/loeschen`).type('form').send({ _csrf: token, begruendung: 'kurz' })).status, 400);
  assert.equal((await buchhaltung.post(`/admin/dateiquarantaene/${id}/loeschen`).type('form').send({ _csrf: token, begruendung: 'Nicht berechtigte Person' })).status, 403);
  const res = await admin.post(`/admin/dateiquarantaene/${id}/wiederherstellen`).type('form').send({ _csrf: token, begruendung: 'Datei wird noch fuer Pruefung benoetigt' });
  assert.equal(res.status, 302);
  assert.equal(existsSync(verwaist), true);
  const entscheidung = db.prepare(`SELECT e.person_id, r.request_id FROM audit_ereignisse e JOIN audit_request_zuordnung r ON r.ereignis_id = e.id
    WHERE e.aktion = 'quarantaene_datei_wiederhergestellt'`).get();
  assert.equal(entscheidung.person_id, '1');
  assert.equal(entscheidung.request_id, res.headers['x-request-id']);
  assert.equal((await admin.post(`/admin/dateiquarantaene/${id}/loeschen`).type('form').send({ _csrf: token, begruendung: 'Bereits entschiedener Eintrag' })).status, 409);
});
