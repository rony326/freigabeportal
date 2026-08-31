import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createKonto } from '../../src/db/kontenRepo.js';
import { createApp } from '../../src/app.js';
import { setupMockChurchTools } from '../helpers/mockChurchTools.js';
import { buildPdfFixture } from '../helpers/pdfFixture.js';
import { fetchCsrfToken } from '../helpers/csrf.js';

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
      customFieldIban: 'IBAN',
      customFieldKontoinhaber: 'Kontoinhaber',
    },
    cronSecret: 'cron-secret',
    n8nApiKey: 'n8n-key',
    smtp: { host: 'smtp.example.org', port: 587, user: 'user', pass: 'pass', from: 'portal@example.org' },
    brandingDir: jobsDir,
    jobsDir,
    downloadSigningSecret: 'download-secret',
  };
}

// Identical to freigabeWorkflowEndToEnd.test.js's loginAs — logs a person in through the real
// /auth/login + /auth/callback flow, mocking exactly the ChurchTools calls that flow makes.
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

function seedGrundlagen(db) {
  upsertPerson(db, { id: '1', vorname: 'Frei', nachname: 'Geber1', email: 'f1@example.org', gruppen: [], loggedInNow: false });
  upsertPerson(db, { id: '2', vorname: 'Stell', nachname: 'Vertreter1', email: 's1@example.org', gruppen: [], loggedInNow: false });
  upsertPerson(db, { id: '3', vorname: 'Frei', nachname: 'Geber2', email: 'f2@example.org', gruppen: [], loggedInNow: false });
  upsertPerson(db, { id: '4', vorname: 'Stell', nachname: 'Vertreter2', email: 's2@example.org', gruppen: [], loggedInNow: false });
  upsertPerson(db, { id: '5', vorname: 'Ein', nachname: 'Reicher', email: 'e@example.org', gruppen: [], loggedInNow: false });
  return createKonto(db, { kontonummer: '1000', bezeichnung: 'Reisespesen', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
}

test('a Spesen position walks the full path: Einreichung -> Freigabe1 -> Freigabe2 -> abholbereit with IBAN', async () => {
  const db = openDatabase(':memory:');
  const jobsDir = mkdtempSync(join(tmpdir(), 'spesen-e2e-'));
  const config = testConfig(jobsDir);
  const app = createApp({ db, config });
  const client = setupMockChurchTools(config.churchtools.baseUrl);
  const kontoId = seedGrundlagen(db);
  const pdf = await buildPdfFixture(['Bahnticket']);

  const einreicherAgent = await loginAs(app, client, { id: 5, vorname: 'Ein', nachname: 'Reicher', email: 'e@example.org', gruppen: [] });
  const einreichenToken = await fetchCsrfToken(einreicherAgent, '/spesen/neu');
  const einreichenRes = await einreicherAgent
    .post('/spesen')
    .field('_csrf', einreichenToken)
    .field('posKontoId', String(kontoId))
    .field('posBetrag', '61.75')
    .field('posAuslageDatum', '2026-08-20')
    .field('posBeschreibung', 'Bahnticket')
    .attach('posBeleg_0', pdf, { filename: 'ticket.pdf', contentType: 'application/pdf' });
  assert.equal(einreichenRes.status, 302);
  assert.equal(einreichenRes.headers.location, '/pool');
  const jobId = db.prepare("SELECT id FROM jobs WHERE quelle = 'spesen'").get().id;

  const freigeber1Agent = await loginAs(app, client, { id: 1, vorname: 'Frei', nachname: 'Geber1', email: 'f1@example.org', gruppen: [] });
  const freigeber1Token = await fetchCsrfToken(freigeber1Agent, `/spesen-freigabe1/${jobId}`);
  const freigabe1Res = await freigeber1Agent
    .post(`/spesen-freigabe1/${jobId}`)
    .type('form')
    .send({ interessenskonflikt: 'nein', begruendung: '', aktion: 'freigeben', _csrf: freigeber1Token });
  assert.equal(freigabe1Res.status, 302);
  assert.equal(db.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId).status, 'freigabe2');

  const freigeber2Agent = await loginAs(app, client, { id: 3, vorname: 'Frei', nachname: 'Geber2', email: 'f2@example.org', gruppen: [] });
  const freigeber2Token = await fetchCsrfToken(freigeber2Agent, `/freigabe2/${jobId}`);
  const freigabe2Res = await freigeber2Agent
    .post(`/freigabe2/${jobId}`)
    .type('form')
    .send({ interessenskonflikt: 'nein', begruendung: '', _csrf: freigeber2Token });
  assert.equal(freigabe2Res.status, 302);
  const abgeschlossenerJob = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  assert.equal(abgeschlossenerJob.status, 'abgeschlossen');
  assert.ok(abgeschlossenerJob.abgeschlossen_am);

  client
    .intercept({ path: '/api/persons/5', method: 'GET' })
    .reply(200, {
      data: {
        id: 5,
        customFields: [
          { id: 30, name: 'IBAN', value: 'CH93 0076 2011 6238 5295 7' },
          { id: 31, name: 'Kontoinhaber', value: 'Ein Reicher' },
        ],
      },
    });
  const abholbereitRes = await request(app).get('/api/n8n/jobs/abholbereit').set('X-API-Key', 'n8n-key');
  assert.equal(abholbereitRes.status, 200);
  const entry = abholbereitRes.body.find((j) => j.id === jobId);
  assert.equal(entry.quelle, 'spesen');
  assert.equal(entry.beschreibung, 'Bahnticket');
  assert.equal(entry.auslage_datum, '2026-08-20');
  assert.equal(entry.eingereicht_von, '5');
  assert.equal(entry.iban, 'CH9300762011623852957');
  assert.equal(entry.kontoinhaber, 'Ein Reicher');

  db.close();
  rmSync(jobsDir, { recursive: true, force: true });
});

test('a self-submitted Spesen position (submitter is the Konto\'s own Freigeber1) is reviewable only by Stellvertreter1, never by the submitter', async () => {
  const db = openDatabase(':memory:');
  const jobsDir = mkdtempSync(join(tmpdir(), 'spesen-e2e-'));
  const config = testConfig(jobsDir);
  const app = createApp({ db, config });
  const client = setupMockChurchTools(config.churchtools.baseUrl);
  const kontoId = seedGrundlagen(db);
  const pdf = await buildPdfFixture(['Parkgebühr']);

  // Person 1 is this Konto's own Freigeber1 — submitting as person 1 must self-escalate to
  // person 2 (Stellvertreter1) rather than assigning the job to the submitter.
  const freigeber1Agent = await loginAs(app, client, { id: 1, vorname: 'Frei', nachname: 'Geber1', email: 'f1@example.org', gruppen: [] });
  const einreichenToken = await fetchCsrfToken(freigeber1Agent, '/spesen/neu');
  const einreichenRes = await freigeber1Agent
    .post('/spesen')
    .field('_csrf', einreichenToken)
    .field('posKontoId', String(kontoId))
    .field('posBetrag', '10.00')
    .field('posAuslageDatum', '2026-08-20')
    .field('posBeschreibung', 'Parkgebühr')
    .attach('posBeleg_0', pdf, { filename: 'beleg.pdf', contentType: 'application/pdf' });
  assert.equal(einreichenRes.status, 302);
  const jobId = db.prepare("SELECT id FROM jobs WHERE quelle = 'spesen'").get().id;
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  assert.equal(job.zugewiesen_an, '2', 'must reassign to Stellvertreter1, never the submitter');
  assert.equal(job.freigabe1_eskalationsgrund, 'Selbsteinreichung durch Freigeber1');

  const submitterViewRes = await freigeber1Agent.get(`/spesen-freigabe1/${jobId}`);
  assert.equal(submitterViewRes.status, 403, 'the submitter must never be able to review their own Freigabe1, even though they are the Konto\'s Freigeber1');

  const stellvertreter1Agent = await loginAs(app, client, { id: 2, vorname: 'Stell', nachname: 'Vertreter1', email: 's1@example.org', gruppen: [] });
  const stellvertreter1Token = await fetchCsrfToken(stellvertreter1Agent, `/spesen-freigabe1/${jobId}`);
  const freigabe1Res = await stellvertreter1Agent
    .post(`/spesen-freigabe1/${jobId}`)
    .type('form')
    .send({ interessenskonflikt: 'nein', begruendung: '', aktion: 'freigeben', _csrf: stellvertreter1Token });
  assert.equal(freigabe1Res.status, 302);
  assert.equal(db.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId).status, 'freigabe2');

  db.close();
  rmSync(jobsDir, { recursive: true, force: true });
});
