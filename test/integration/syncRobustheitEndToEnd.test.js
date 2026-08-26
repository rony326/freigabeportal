import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson, getPersonById } from '../../src/db/personenRepo.js';
import { createKonto } from '../../src/db/kontenRepo.js';
import { createDebitor } from '../../src/db/debitorenRepo.js';
import { seedDefaults } from '../../src/db/adminConfigRepo.js';
import { createJob, getJobById } from '../../src/db/jobsRepo.js';
import { listMailLog } from '../../src/db/mailLogRepo.js';
import { createApp } from '../../src/app.js';
import { setupMockChurchTools } from '../helpers/mockChurchTools.js';
import { buildPdfFixture } from '../helpers/pdfFixture.js';

function testConfig(jobsDir) {
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
    smtp: { host: 'smtp.example.org', port: 587, user: 'user', pass: 'pass', from: 'portal@example.org' },
    publicBaseUrl: 'http://portal.example.org',
    brandingDir: jobsDir,
    jobsDir,
    downloadSigningSecret: 'download-secret',
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

  const agent = request.agent(app);
  const loginRes = await agent.get('/auth/login');
  const state = new URL(loginRes.headers.location).searchParams.get('state');
  const callbackRes = await agent.get('/auth/callback').query({ code: `code-${id}`, state });
  assert.equal(callbackRes.status, 302, `login for person ${id} should succeed`);
  return agent;
}

test('a doubly-conflicted Freigabe-1 handoff reaches an admin, who takes it all the way to completion', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  const jobsDir = mkdtempSync(join(tmpdir(), 'sync-robustheit-e2e-test-'));
  const config = testConfig(jobsDir);
  const app = createApp({ db, config });
  const client = setupMockChurchTools(config.churchtools.baseUrl);

  upsertPerson(db, { id: '1', vorname: 'Freigeber', nachname: 'Eins', email: 'f1@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '2', vorname: 'Stellvertreter', nachname: 'Eins', email: 's1@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '3', vorname: 'Freigeber', nachname: 'Zwei', email: 'f2@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '4', vorname: 'Stellvertreter', nachname: 'Zwei', email: 's2@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '99', vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'], loggedInNow: false });
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  const debitorId = createDebitor(db, { name: 'Muster AG', kontoId: null });
  const pdfPfad = join(jobsDir, 'e2e-sync-robustheit.pdf');
  writeFileSync(pdfPfad, await buildPdfFixture(['Rechnung', 'Visum']));
  const jobId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad });
  db.prepare("UPDATE jobs SET status = 'zugewiesen', zugewiesen_an = '1' WHERE id = ?").run(jobId);

  const freigeber1Agent = await loginAs(app, client, { id: 1, vorname: 'Freigeber', nachname: 'Eins', email: 'f1@example.org', gruppen: ['10'] });
  await freigeber1Agent.post(`/kontierung/${jobId}`).type('form').send({ kontoId: String(kontoId), debitorId: String(debitorId), absender: 'Muster AG', rechnungsnummer: 'RE-1', betrag: '100.00', zahlungsziel: '2026-09-01', interessenskonflikt: 'ja', begruendung: 'Befangen.' });

  const stellvertreter1Agent = await loginAs(app, client, { id: 2, vorname: 'Stellvertreter', nachname: 'Eins', email: 's1@example.org', gruppen: ['10'] });
  const eskalationRes = await stellvertreter1Agent
    .post(`/kontierung/${jobId}`)
    .type('form')
    .send({ kontoId: String(kontoId), debitorId: String(debitorId), absender: 'Muster AG', rechnungsnummer: 'RE-1', betrag: '100.00', zahlungsziel: '2026-09-01', interessenskonflikt: 'ja', begruendung: 'Auch befangen.' });
  assert.equal(eskalationRes.status, 302);
  assert.equal(getJobById(db, jobId).freigabe1_eskaliert_an_admin, 1);
  assert.equal(listMailLog(db).filter((m) => m.empfaenger === 'admin@example.org').length, 1);

  const adminAgent = await loginAs(app, client, { id: 99, vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'] });
  const kontierungRes = await adminAgent
    .post(`/kontierung/${jobId}`)
    .type('form')
    .send({ kontoId: String(kontoId), debitorId: String(debitorId), absender: 'Muster AG', rechnungsnummer: 'RE-1', betrag: '100.00', zahlungsziel: '2026-09-01', interessenskonflikt: 'nein', begruendung: '' });
  assert.equal(kontierungRes.status, 302);
  assert.equal(getJobById(db, jobId).status, 'freigabe2');

  const freigeber2Agent = await loginAs(app, client, { id: 3, vorname: 'Freigeber', nachname: 'Zwei', email: 'f2@example.org', gruppen: ['10'] });
  const freigabe2Res = await freigeber2Agent.post(`/freigabe2/${jobId}`).type('form').send({ interessenskonflikt: 'nein', begruendung: '' });
  assert.equal(freigabe2Res.status, 302);
  assert.equal(getJobById(db, jobId).status, 'abgeschlossen');

  db.close();
  rmSync(jobsDir, { recursive: true, force: true });
});

test('a mass-deactivation sync run aborts cleanly, and a subsequent normal run still works', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  const jobsDir = mkdtempSync(join(tmpdir(), 'sync-robustheit-e2e-abort-test-'));
  const config = testConfig(jobsDir);
  const app = createApp({ db, config });
  const client = setupMockChurchTools(config.churchtools.baseUrl);

  upsertPerson(db, { id: '99', vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'], loggedInNow: false });
  for (let i = 1; i <= 20; i++) {
    upsertPerson(db, { id: String(i), vorname: `Person${i}`, nachname: 'Aktiv', email: `p${i}@example.org`, gruppen: ['10'], loggedInNow: false });
  }

  // First run: ChurchTools returns almost nobody — the guard should trip.
  client.intercept({ path: '/api/groups/10/members', method: 'GET' }).reply(200, { data: [{ personId: 1 }] });
  client.intercept({ path: '/api/groups/20/members', method: 'GET' }).reply(200, { data: [{ personId: 99 }] });
  client.intercept({ path: '/api/persons/1', method: 'GET' }).reply(200, { data: { id: 1, firstName: 'Person1', lastName: 'Aktiv', email: 'p1@example.org' } });
  client.intercept({ path: '/api/persons/99', method: 'GET' }).reply(200, { data: { id: 99, firstName: 'Admina', lastName: 'Portal', email: 'admin@example.org' } });

  const abortRes = await request(app).post('/internal/cron/sync-personen').set('X-Cron-Secret', 'cron-secret');
  assert.equal(abortRes.body.status, 'abgebrochen');
  assert.equal(getPersonById(db, '20').aktiv, true, 'nothing should have been deactivated');
  assert.ok(listMailLog(db).some((m) => m.typ === 'sync-fehler'));

  // Second run: ChurchTools returns everyone as before — a completely normal run should still
  // succeed (the guard doesn't get "stuck" tripped).
  client.intercept({ path: '/api/groups/10/members', method: 'GET' }).reply(200, Array.from({ length: 20 }, (_, i) => ({ personId: i + 1 })).length ? { data: Array.from({ length: 20 }, (_, i) => ({ personId: i + 1 })) } : { data: [] });
  client.intercept({ path: '/api/groups/20/members', method: 'GET' }).reply(200, { data: [{ personId: 99 }] });
  for (let i = 1; i <= 20; i++) {
    client.intercept({ path: `/api/persons/${i}`, method: 'GET' }).reply(200, { data: { id: i, firstName: `Person${i}`, lastName: 'Aktiv', email: `p${i}@example.org` } });
  }
  client.intercept({ path: '/api/persons/99', method: 'GET' }).reply(200, { data: { id: 99, firstName: 'Admina', lastName: 'Portal', email: 'admin@example.org' } });

  const okRes = await request(app).post('/internal/cron/sync-personen').set('X-Cron-Secret', 'cron-secret');
  assert.equal(okRes.body.status, 'erfolg');
  db.close();
  rmSync(jobsDir, { recursive: true, force: true });
});
