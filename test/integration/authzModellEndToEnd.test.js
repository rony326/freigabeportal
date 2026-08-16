import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createKonto } from '../../src/db/kontenRepo.js';
import { seedDefaults } from '../../src/db/adminConfigRepo.js';
import { createJob, getJobById } from '../../src/db/jobsRepo.js';
import { listMailLog } from '../../src/db/mailLogRepo.js';
import { createApp } from '../../src/app.js';
import { setupMockChurchTools } from '../helpers/mockChurchTools.js';

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
    smtp: { host: 'smtp.example.org', port: 587, user: 'user', pass: 'pass', from: 'portal@example.org' },
    publicBaseUrl: 'http://portal.example.org',
    downloadSigningSecret: 'download-secret',
  };
}

async function loginAs(app, client, { id, vorname, nachname, email, gruppen }) {
  client.intercept({ path: '/api/oauth/token', method: 'POST' }).reply(200, { access_token: `tok-${id}` });
  client.intercept({ path: '/api/whoami', method: 'GET' }).reply(200, { data: { id, firstName: vorname, lastName: nachname, email } });
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

test('a Freigabe-1 conflict escalated to admin survives a Freigabe-2 rejection: the excluded Stellvertreter1 stays locked out, the admin reworks it', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  const config = testConfig();
  const app = createApp({ db, config });
  const client = setupMockChurchTools(config.churchtools.baseUrl);

  upsertPerson(db, { id: '1', vorname: 'Freigeber', nachname: 'Eins', email: 'f1@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '2', vorname: 'Stellvertreter', nachname: 'Eins', email: 's1@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '3', vorname: 'Freigeber', nachname: 'Zwei', email: 'f2@example.org', gruppen: [], loggedInNow: false });
  upsertPerson(db, { id: '4', vorname: 'Stellvertreter', nachname: 'Zwei', email: 's2@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '99', vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'], loggedInNow: false });
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare("UPDATE jobs SET status = 'zugewiesen', zugewiesen_an = '1' WHERE id = ?").run(jobId);

  const freigeber1Agent = await loginAs(app, client, { id: 1, vorname: 'Freigeber', nachname: 'Eins', email: 'f1@example.org', gruppen: ['10'] });
  await freigeber1Agent.post(`/kontierung/${jobId}`).type('form').send({ kontoId: String(kontoId), interessenskonflikt: 'ja', begruendung: 'Befangen.' });

  const stellvertreter1Agent = await loginAs(app, client, { id: 2, vorname: 'Stellvertreter', nachname: 'Eins', email: 's1@example.org', gruppen: ['10'] });
  await stellvertreter1Agent.post(`/kontierung/${jobId}`).type('form').send({ kontoId: String(kontoId), interessenskonflikt: 'ja', begruendung: 'Auch befangen.' });
  assert.equal(getJobById(db, jobId).freigabe1_eskaliert_an_admin, 1);

  const adminAgent = await loginAs(app, client, { id: 99, vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'] });
  const kontierungRes = await adminAgent
    .post(`/kontierung/${jobId}`)
    .type('form')
    .send({ kontoId: String(kontoId), interessenskonflikt: 'nein', begruendung: '' });
  assert.equal(kontierungRes.status, 302);
  assert.equal(getJobById(db, jobId).status, 'freigabe2');
  assert.equal(getJobById(db, jobId).freigabe1_eskaliert_an_admin, 1, "the exclusion must survive Freigabe 1's own completion");

  // Freigeber 2 has no group membership at all — also proves AUTHZ-3's route-gate removal.
  const freigeber2Agent = await loginAs(app, client, { id: 3, vorname: 'Freigeber', nachname: 'Zwei', email: 'f2@example.org', gruppen: [] });
  const ablehnenRes = await freigeber2Agent
    .post(`/freigabe2/${jobId}`)
    .type('form')
    .send({ aktion: 'ablehnen', interessenskonflikt: 'nein', begruendung: 'Falsches Konto gewählt.' });
  assert.equal(ablehnenRes.status, 302);
  assert.equal(getJobById(db, jobId).status, 'abgelehnt');
  assert.ok(
    listMailLog(db).some((m) => m.typ === 'ablehnung' && m.empfaenger === 'admin@example.org' && m.text.includes(`/abgelehnt/${jobId}`)),
    'the rejection notice must go to the admin group with a direct link, not to the excluded Stellvertreter1'
  );

  // The originally-assigned, now-excluded Stellvertreter1 must not be able to see or rework it.
  const stellvertreter1BlockedRes = await stellvertreter1Agent.get(`/abgelehnt/${jobId}`);
  assert.equal(stellvertreter1BlockedRes.status, 403);

  // The admin reworks it instead.
  const adminAbgelehntRes = await adminAgent.get(`/abgelehnt/${jobId}`);
  assert.equal(adminAbgelehntRes.status, 200);
  const ueberarbeitenRes = await adminAgent.post(`/abgelehnt/${jobId}/ueberarbeiten`);
  assert.equal(ueberarbeitenRes.status, 302);
  assert.equal(ueberarbeitenRes.headers.location, `/kontierung/${jobId}`);
  assert.equal(getJobById(db, jobId).status, 'zugewiesen');

  // The excluded Stellvertreter1 still can't touch Kontierung after the reopen.
  const stellvertreter1StillBlockedRes = await stellvertreter1Agent.get(`/kontierung/${jobId}`);
  assert.equal(stellvertreter1StillBlockedRes.status, 403);

  db.close();
});
