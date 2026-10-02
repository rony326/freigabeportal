import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/db/index.js';
import { seedDefaults } from '../../src/db/adminConfigRepo.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createKonto } from '../../src/db/kontenRepo.js';
import { createKreditor } from '../../src/db/kreditorenRepo.js';
import { createApp } from '../../src/app.js';
import { setupMockChurchTools } from '../helpers/mockChurchTools.js';
import { buildPdfFixture } from '../helpers/pdfFixture.js';
import { fetchCsrfToken } from '../helpers/csrf.js';
import { buildQrBillPdfFixture } from '../helpers/qrBillFixture.js';
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

// Logs a person in through the real /auth/login + /auth/callback flow, mocking exactly the
// ChurchTools calls that flow makes (see src/routes/auth.js + src/services/churchtools.js).
// Registers and fully consumes its four mocked responses before returning, so sequential calls
// for different people never race over the same intercepted path.
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

test('Pool → Beanspruchen → Kontierung → Freigabe 2 completes the job with a stamped, downloadable PDF', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  const jobsDir = mkdtempSync(join(tmpdir(), 'e2e-test-'));
  const config = testConfig(jobsDir);
  const app = createApp({ db, config });
  const client = setupMockChurchTools(config.churchtools.baseUrl);

  upsertPerson(db, { id: '1', vorname: 'Freigeber', nachname: 'Eins', email: 'f1@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '2', vorname: 'Stellvertreter', nachname: 'Eins', email: 's1@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '3', vorname: 'Freigeber', nachname: 'Zwei', email: 'f2@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '4', vorname: 'Stellvertreter', nachname: 'Zwei', email: 's2@example.org', gruppen: ['10'], loggedInNow: false });
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  const kreditorId = createKreditor(db, { name: 'Muster AG', kontoId: null });

  const pdf = await buildPdfFixture(['Rechnung Seite 1', 'Visum / Rechnungsfreigabe']);
  const createRes = await request(app)
    .post('/api/n8n/jobs')
    .set('X-API-Key', 'n8n-key')
    .field('quelle', 'scanner')
    .field('dateiname', 'rechnung.pdf')
    .attach('pdf', pdf, { filename: 'rechnung.pdf', contentType: 'application/pdf' });
  assert.equal(createRes.status, 201);
  const jobId = createRes.body.id;
  assert.equal(createRes.body.status, 'unzugewiesen');

  const freigeber1Agent = await loginAs(app, client, { id: 1, vorname: 'Freigeber', nachname: 'Eins', email: 'f1@example.org', gruppen: ['10'] });
  const freigeber1Token = await fetchCsrfToken(freigeber1Agent, '/pool');
  const claimRes = await freigeber1Agent.post(`/api/pool/${jobId}/beanspruchen`).type('form').send({ _csrf: freigeber1Token });
  assert.equal(claimRes.status, 200);

  const kontierungRes = await freigeber1Agent
    .post(`/kontierung/${jobId}`)
    .type('form')
    .send({ kontoId: String(kontoId), kreditorId: String(kreditorId), absender: 'Muster AG', rechnungsnummer: 'RE-1', betrag: '100.00', zahlungsziel: '2026-09-01', interessenskonflikt: 'nein', begruendung: '', _csrf: freigeber1Token });
  assert.equal(kontierungRes.status, 302);

  const freigeber2Agent = await loginAs(app, client, { id: 3, vorname: 'Freigeber', nachname: 'Zwei', email: 'f2@example.org', gruppen: ['10'] });
  const freigeber2Token = await fetchCsrfToken(freigeber2Agent, '/pool');
  const freigabe2Res = await freigeber2Agent
    .post(`/freigabe2/${jobId}`)
    .type('form')
    .send({ interessenskonflikt: 'nein', begruendung: '', _csrf: freigeber2Token });
  assert.equal(freigabe2Res.status, 302);

  const abholbereitRes = await request(app).get('/api/n8n/jobs/abholbereit').set('X-API-Key', 'n8n-key');
  assert.equal(abholbereitRes.status, 200);
  assert.equal(abholbereitRes.body.length, 1);
  assert.equal(abholbereitRes.body[0].id, jobId);

  const downloadRes = await request(app).get(abholbereitRes.body[0].download_url);
  assert.equal(downloadRes.status, 200);
  const mdoc = mupdf.Document.openDocument(downloadRes.body, 'application/pdf');
  const lastPageText = mdoc.loadPage(mdoc.countPages() - 1).toStructuredText().asText();
  assert.match(lastPageText, /Eins/);
  assert.match(lastPageText, /Zwei/);

  db.close();
  rmSync(jobsDir, { recursive: true, force: true });
});

test('a scanned QR invoice runs intake → Kontierung → confirmed payment at Freigabe 2 → export → archive receipt with one frozen payment', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  const jobsDir = mkdtempSync(join(tmpdir(), 'e2e-qr-test-'));
  const config = testConfig(jobsDir);
  const app = createApp({ db, config });
  const client = setupMockChurchTools(config.churchtools.baseUrl);

  upsertPerson(db, { id: '1', vorname: 'Freigeber', nachname: 'Eins', email: 'f1@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '2', vorname: 'Stellvertreter', nachname: 'Eins', email: 's1@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '3', vorname: 'Freigeber', nachname: 'Zwei', email: 'f2@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '4', vorname: 'Stellvertreter', nachname: 'Zwei', email: 's2@example.org', gruppen: ['10'], loggedInNow: false });
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  const kreditorId = createKreditor(db, { name: 'Muster AG', kontoId: null });

  const pdf = await buildQrBillPdfFixture({
    amount: 1949.75,
    creditor: { account: 'CH4431999123000889012', address: 'Musterstrasse', buildingNumber: 7, city: 'Musterstadt', country: 'CH', name: 'Muster AG', zip: 1234 },
    currency: 'CHF',
    reference: '210000000003139471430009017',
  });
  const createRes = await request(app).post('/api/n8n/jobs').set('X-API-Key', 'n8n-key')
    .field('quelle', 'scanner').field('dateiname', 'qr-rechnung.pdf')
    .attach('pdf', pdf, { filename: 'qr-rechnung.pdf', contentType: 'application/pdf' });
  assert.equal(createRes.status, 201);
  const jobId = createRes.body.id;

  const freigeber1Agent = await loginAs(app, client, { id: 1, vorname: 'Freigeber', nachname: 'Eins', email: 'f1@example.org', gruppen: ['10'] });
  const freigeber1Token = await fetchCsrfToken(freigeber1Agent, '/pool');
  assert.equal((await freigeber1Agent.post(`/api/pool/${jobId}/beanspruchen`).type('form').send({ _csrf: freigeber1Token })).status, 200);
  const kontierungRes = await freigeber1Agent.post(`/kontierung/${jobId}`).type('form')
    .send({ kontoId: String(kontoId), kreditorId: String(kreditorId), absender: 'Muster AG', rechnungsnummer: 'RE-QR', betrag: '1949.75', zahlungsziel: '2026-10-15', interessenskonflikt: 'nein', begruendung: '', _csrf: freigeber1Token });
  assert.equal(kontierungRes.status, 302);

  const freigeber2Agent = await loginAs(app, client, { id: 3, vorname: 'Freigeber', nachname: 'Zwei', email: 'f2@example.org', gruppen: ['10'] });
  const formular = await freigeber2Agent.get(`/freigabe2/${jobId}`);
  assert.equal(formular.status, 200);
  assert.match(formular.text, /CH4431999123000889012/);
  const stand = formular.text.match(/name="zahlungsdaten_stand" value="([a-f0-9]+)"/)[1];
  const token = formular.text.match(/name="_csrf" value="([^"]+)"/)[1];
  const ohne = await freigeber2Agent.post(`/freigabe2/${jobId}`).type('form').send({ interessenskonflikt: 'nein', begruendung: '', _csrf: token });
  assert.equal(ohne.status, 400);
  assert.equal((await request(app).get('/api/n8n/jobs/abholbereit').set('X-API-Key', 'n8n-key')).body.length, 0);
  const freigabe2Res = await freigeber2Agent.post(`/freigabe2/${jobId}`).type('form')
    .send({ interessenskonflikt: 'nein', begruendung: '', zahlungsdaten_stand: stand, zahlungsdaten_bestaetigt: 'ja', _csrf: token });
  assert.equal(freigabe2Res.status, 302);

  const [eintrag] = (await request(app).get('/api/n8n/jobs/abholbereit').set('X-API-Key', 'n8n-key')).body;
  assert.equal(eintrag.id, jobId);
  assert.equal(eintrag.zahlung.art, 'qr_rechnung');
  assert.equal(eintrag.zahlung.freigegeben, true);
  assert.equal(eintrag.zahlung.iban, 'CH4431999123000889012');
  assert.equal(eintrag.zahlung.referenz, '210000000003139471430009017');
  assert.equal(eintrag.zahlung.bestaetigt_von, '3');

  const manifest = (await request(app).get(`/api/n8n/jobs/${jobId}/exportnachweis`).set('X-API-Key', 'n8n-key')).body;
  assert.equal(manifest.version, 2);
  assert.deepEqual(manifest.zahlung, eintrag.zahlung);
  const bytes = await request(app).get(manifest.download_pfad).set('X-API-Key', 'n8n-key').buffer(true).parse((res, cb) => {
    const teile = [];
    res.on('data', (teil) => teile.push(teil));
    res.on('end', () => cb(null, Buffer.concat(teile)));
  });
  assert.equal(bytes.status, 200);
  const mdoc = mupdf.Document.openDocument(bytes.body, 'application/pdf');
  const stempel = mdoc.loadPage(mdoc.countPages() - 1).toStructuredText().asText();
  assert.match(stempel, /IBAN: CH4431999123000889012/);
  const quittung = await request(app).post(`/api/n8n/jobs/${jobId}/archivierung-bestaetigen`).set('X-API-Key', 'n8n-key')
    .send({ export_id: manifest.export_id, sha256: manifest.sha256, dokument_id: 7, task_id: 'b2ba769c-455f-4d97-9fb6-986eac19a334' });
  assert.equal(quittung.status, 200);

  db.close();
  rmSync(jobsDir, { recursive: true, force: true });
});
