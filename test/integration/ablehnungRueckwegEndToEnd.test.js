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
import * as mupdf from 'mupdf';

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
    n8nApiKey: 'n8n-key',
    smtp: { host: 'smtp.example.org', port: 587, user: 'user', pass: 'pass', from: 'portal@example.org' },
    brandingDir: jobsDir,
    jobsDir,
    downloadSigningSecret: 'download-secret',
  };
}

async function loginAs(app, client, { id, vorname, nachname, email, gruppen }) {
  client.intercept({ path: '/oauth/access_token', method: 'POST' }).reply(200, { access_token: `tok-${id}` });
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

test('Kontierung → Freigabe 2 Ablehnen → Meine abgelehnten Jobs → Überarbeiten → erneute Kontierung/Freigabe 2 → abgeschlossen mit vollständigem Verlauf', async () => {
  const db = openDatabase(':memory:');
  const jobsDir = mkdtempSync(join(tmpdir(), 'ablehnung-e2e-test-'));
  const config = testConfig(jobsDir);
  const app = createApp({ db, config });
  const client = setupMockChurchTools(config.churchtools.baseUrl);

  upsertPerson(db, { id: '1', vorname: 'Freigeber', nachname: 'Eins', email: 'f1@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '3', vorname: 'Freigeber', nachname: 'Zwei', email: 'f2@example.org', gruppen: ['10'], loggedInNow: false });
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '1', freigeber2Id: '3', stellvertreter2Id: '3' });

  const pdf = await buildPdfFixture(['Rechnung Seite 1', 'Visum / Rechnungsfreigabe']);
  const createRes = await request(app)
    .post('/api/n8n/jobs')
    .set('X-API-Key', 'n8n-key')
    .field('quelle', 'scanner')
    .field('dateiname', 'rechnung.pdf')
    .attach('pdf', pdf, { filename: 'rechnung.pdf', contentType: 'application/pdf' });
  assert.equal(createRes.status, 201);
  const jobId = createRes.body.id;

  const freigeber1Agent = await loginAs(app, client, { id: 1, vorname: 'Freigeber', nachname: 'Eins', email: 'f1@example.org', gruppen: ['10'] });
  await freigeber1Agent.post(`/api/pool/${jobId}/beanspruchen`);
  await freigeber1Agent.post(`/kontierung/${jobId}`).type('form').send({ kontoId: String(kontoId), interessenskonflikt: 'nein', begruendung: '' });

  const freigeber2Agent = await loginAs(app, client, { id: 3, vorname: 'Freigeber', nachname: 'Zwei', email: 'f2@example.org', gruppen: ['10'] });
  const ablehnenRes = await freigeber2Agent
    .post(`/freigabe2/${jobId}`)
    .type('form')
    .send({ aktion: 'ablehnen', interessenskonflikt: 'nein', begruendung: 'Rechnungsnummer stimmt nicht' });
  assert.equal(ablehnenRes.status, 302);

  const poolResAfterAblehnung = await freigeber1Agent.get('/pool');
  assert.match(poolResAfterAblehnung.text, /rechnung\.pdf/);
  assert.match(poolResAfterAblehnung.text, new RegExp(`/abgelehnt/${jobId}`));

  const ueberarbeitenRes = await freigeber1Agent.post(`/abgelehnt/${jobId}/ueberarbeiten`);
  assert.equal(ueberarbeitenRes.status, 302);
  assert.equal(ueberarbeitenRes.headers.location, `/kontierung/${jobId}`);

  await freigeber1Agent.post(`/kontierung/${jobId}`).type('form').send({ kontoId: String(kontoId), interessenskonflikt: 'nein', begruendung: '' });
  const freigebenRes = await freigeber2Agent
    .post(`/freigabe2/${jobId}`)
    .type('form')
    .send({ aktion: 'freigeben', interessenskonflikt: 'nein', begruendung: '' });
  assert.equal(freigebenRes.status, 302);

  const abholbereitRes = await request(app).get('/api/n8n/jobs/abholbereit').set('X-API-Key', 'n8n-key');
  assert.equal(abholbereitRes.status, 200);
  assert.equal(abholbereitRes.body.length, 1);

  const downloadRes = await request(app).get(abholbereitRes.body[0].download_url);
  assert.equal(downloadRes.status, 200);
  const mdoc = mupdf.Document.openDocument(downloadRes.body, 'application/pdf');
  assert.ok(mdoc.countPages() >= 3, 'expected the original page + Visum page + at least one appended Verlauf page');

  const verlaufText = mdoc.loadPage(mdoc.countPages() - 1).toStructuredText().asText();
  assert.match(verlaufText, /Abgelehnt/);
  assert.match(verlaufText, /Rechnungsnummer stimmt nicht/);
  assert.match(verlaufText, /Freigabe 1/);
  assert.match(verlaufText, /Freigabe 2/);

  const visumText = mdoc.loadPage(mdoc.countPages() - 2).toStructuredText().asText();
  assert.match(visumText, /Eins/);
  assert.match(visumText, /Zwei/);

  db.close();
  rmSync(jobsDir, { recursive: true, force: true });
});

test('a job rejected twice before final approval carries both rejections in the Verlauf', async () => {
  const db = openDatabase(':memory:');
  const jobsDir = mkdtempSync(join(tmpdir(), 'ablehnung-e2e-doppel-test-'));
  const config = testConfig(jobsDir);
  const app = createApp({ db, config });
  const client = setupMockChurchTools(config.churchtools.baseUrl);

  upsertPerson(db, { id: '1', vorname: 'Freigeber', nachname: 'Eins', email: 'f1@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '3', vorname: 'Freigeber', nachname: 'Zwei', email: 'f2@example.org', gruppen: ['10'], loggedInNow: false });
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '1', freigeber2Id: '3', stellvertreter2Id: '3' });

  const pdf = await buildPdfFixture(['Rechnung Seite 1', 'Visum / Rechnungsfreigabe']);
  const createRes = await request(app)
    .post('/api/n8n/jobs')
    .set('X-API-Key', 'n8n-key')
    .field('quelle', 'scanner')
    .field('dateiname', 'rechnung.pdf')
    .attach('pdf', pdf, { filename: 'rechnung.pdf', contentType: 'application/pdf' });
  const jobId = createRes.body.id;

  const freigeber1Agent = await loginAs(app, client, { id: 1, vorname: 'Freigeber', nachname: 'Eins', email: 'f1@example.org', gruppen: ['10'] });
  const freigeber2Agent = await loginAs(app, client, { id: 3, vorname: 'Freigeber', nachname: 'Zwei', email: 'f2@example.org', gruppen: ['10'] });

  await freigeber1Agent.post(`/api/pool/${jobId}/beanspruchen`);
  for (const grund of ['Erster Ablehnungsgrund', 'Zweiter Ablehnungsgrund']) {
    await freigeber1Agent.post(`/kontierung/${jobId}`).type('form').send({ kontoId: String(kontoId), interessenskonflikt: 'nein', begruendung: '' });
    await freigeber2Agent.post(`/freigabe2/${jobId}`).type('form').send({ aktion: 'ablehnen', interessenskonflikt: 'nein', begruendung: grund });
    await freigeber1Agent.post(`/abgelehnt/${jobId}/ueberarbeiten`);
  }
  await freigeber1Agent.post(`/kontierung/${jobId}`).type('form').send({ kontoId: String(kontoId), interessenskonflikt: 'nein', begruendung: '' });
  await freigeber2Agent.post(`/freigabe2/${jobId}`).type('form').send({ aktion: 'freigeben', interessenskonflikt: 'nein', begruendung: '' });

  const abholbereitRes = await request(app).get('/api/n8n/jobs/abholbereit').set('X-API-Key', 'n8n-key');
  const downloadRes = await request(app).get(abholbereitRes.body[0].download_url);
  const mdoc = mupdf.Document.openDocument(downloadRes.body, 'application/pdf');

  let allVerlaufText = '';
  for (let i = 2; i < mdoc.countPages(); i++) {
    allVerlaufText += mdoc.loadPage(i).toStructuredText().asText();
  }
  assert.match(allVerlaufText, /Erster Ablehnungsgrund/);
  assert.match(allVerlaufText, /Zweiter Ablehnungsgrund/);

  db.close();
  rmSync(jobsDir, { recursive: true, force: true });
});
