// S5: Eigenlimits je Person für Spesen einreichen (10/h) und Fehler melden (5/h), mit der echten App (createApp).
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
import { createApp } from '../../src/app.js';
import { setupMockChurchTools } from '../helpers/mockChurchTools.js';
import { PNG_1X1 } from '../helpers/imageFixture.js';
import { fetchCsrfToken } from '../helpers/csrf.js';

function testConfig(jobsDir) {
  return {
    sessionSecret: 'test-secret', env: 'test',
    churchtools: { baseUrl: 'https://ct.example.org', clientId: 'c', clientSecret: 's', redirectUri: 'https://portal.example.org/auth/callback', groupIdBuchhaltung: '10', groupIdAdmin: '20', syncServiceToken: 't', customFieldIban: 'iban_1', customFieldKontoinhaber: 'kontoinhaber' },
    cronSecret: 'cron-secret', n8nApiKey: 'n8n-key', brandingDir: jobsDir, jobsDir, downloadSigningSecret: 'download-secret',
  };
}

async function loginAs(app, client, id) {
  client.intercept({ path: '/oauth/access_token', method: 'POST' }).reply(200, { access_token: `tok-${id}` });
  client.intercept({ path: '/oauth/userinfo', method: 'GET' }).reply(200, { id, firstName: 'P', lastName: id, email: `p${id}@example.org` });
  client.intercept({ path: '/api/groups/10/members', method: 'GET' }).reply(200, { data: [{ personId: id }] });
  client.intercept({ path: '/api/groups/20/members', method: 'GET' }).reply(200, { data: [] });
  const agent = request.agent(app);
  const loginRes = await agent.get('/auth/login');
  const state = new URL(loginRes.headers.location).searchParams.get('state');
  const cb = await agent.get('/auth/callback').query({ code: `code-${id}`, state });
  assert.equal(cb.status, 302, cb.text);
  return agent;
}

function setup() {
  const jobsDir = mkdtempSync(join(tmpdir(), 'schreiblimit-'));
  const db = openDatabase(':memory:');
  seedDefaults(db);
  for (const id of ['1', '2', '3', '4', '5', '6']) upsertPerson(db, { id, vorname: 'P', nachname: id, email: `p${id}@example.org`, gruppen: ['10'], loggedInNow: true });
  createKonto(db, { kontonummer: '1000', bezeichnung: 'Reisespesen', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  const client = setupMockChurchTools('https://ct.example.org');
  const app = createApp({ db, config: testConfig(jobsDir) });
  return { db, app, client, aufraeumen: () => { db.close(); rmSync(jobsDir, { recursive: true, force: true }); } };
}

function spesenPost(agent, token, { gueltig = true } = {}) {
  const req = agent.post('/spesen').field('_csrf', token).field('posKontoId', '1').field('posBetrag', gueltig ? '10.00' : 'x')
    .field('posAuslageDatum', '2026-01-01').field('posBeschreibung', 'Zug')
    .attach('posBeleg_0', PNG_1X1, { filename: 'b.png', contentType: 'image/png' });
  return req;
}

test('S5: die 11. Spesenabrechnung innerhalb einer Stunde wird mit 429 und Meldung abgelehnt, andere Personen sind nicht betroffen', async () => {
  const { app, client, aufraeumen } = setup();
  const a = await loginAs(app, client, '5');
  const tokenA = await fetchCsrfToken(a, '/spesen/neu');
  for (let i = 1; i <= 10; i++) {
    const res = await spesenPost(a, tokenA);
    assert.equal(res.status, 302, `Abrechnung ${i} soll angenommen werden`);
  }
  const elf = await spesenPost(a, tokenA).set('Accept', 'text/html');
  assert.equal(elf.status, 429);
  assert.match(elf.text, /bereits 10 Spesenabrechnungen/);
  assert.match(elf.text, /in etwa \d+ Minuten/);
  const json = await spesenPost(a, tokenA);
  assert.equal(json.status, 429);
  assert.match(json.body.error, /10 Spesenabrechnungen/);
  assert.ok(json.headers['retry-after']);

  const b = await loginAs(app, client, '6');
  const tokenB = await fetchCsrfToken(b, '/spesen/neu');
  assert.equal((await spesenPost(b, tokenB)).status, 302, 'andere Person ist nicht betroffen');
  // Seitenaufrufe (GET) bleiben auch für die gesperrte Person möglich.
  assert.equal((await a.get('/spesen/neu')).status, 200);
  aufraeumen();
});

test('S5: abgelehnte Spesen-Eingaben (400) zählen nicht zum Kontingent', async () => {
  const { app, client, aufraeumen } = setup();
  const a = await loginAs(app, client, '5');
  const token = await fetchCsrfToken(a, '/spesen/neu');
  for (let i = 0; i < 12; i++) assert.equal((await spesenPost(a, token, { gueltig: false })).status, 400);
  assert.equal((await spesenPost(a, token)).status, 302);
  aufraeumen();
});

test('S5: die 6. Fehlermeldung innerhalb einer Stunde wird mit 429 abgelehnt, andere Personen nicht betroffen', async () => {
  const { app, client, aufraeumen } = setup();
  const a = await loginAs(app, client, '5');
  const token = await fetchCsrfToken(a, '/fehler-melden');
  const senden = (agent, t) => agent.post('/fehler-melden').type('form').send({ _csrf: t, beschreibung: 'kaputt' });
  for (let i = 1; i <= 5; i++) assert.equal((await senden(a, token)).status, 200, `Meldung ${i}`);
  const sechs = await senden(a, token).set('Accept', 'text/html');
  assert.equal(sechs.status, 429);
  assert.match(sechs.text, /bereits 5 Fehlermeldungen/);
  const b = await loginAs(app, client, '6');
  assert.equal((await senden(b, await fetchCsrfToken(b, '/fehler-melden'))).status, 200);
  aufraeumen();
});
