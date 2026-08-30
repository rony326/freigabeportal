import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createKonto } from '../../src/db/kontenRepo.js';
import { createJob, getJobById, listSplitKinder } from '../../src/db/jobsRepo.js';
import { createApp } from '../../src/app.js';
import { buildPdfFixture } from '../helpers/pdfFixture.js';
import { fetchCsrfToken } from '../helpers/csrf.js';
import { setupMockChurchTools } from '../helpers/mockChurchTools.js';

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
    jobsDir,
    // http, not https: app.js derives the session cookie's Secure flag from publicBaseUrl, and a
    // Secure cookie set over supertest's plain-HTTP connection would never be sent back on the
    // next request, breaking the real agent-driven /auth/login -> /auth/callback flow below (see
    // authzModellEndToEnd.test.js for the same pattern).
    publicBaseUrl: 'http://portal.example.org',
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

test('a 3-Konten Aufsplitten flow ends in a single combined Bexio export, with all Splitkind files cleaned up after Abholung', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'splitgruppen-e2e-test-'));
  const config = testConfig(dir);
  const client = setupMockChurchTools(config.churchtools.baseUrl);
  const db = openDatabase(':memory:');

  upsertPerson(db, { id: '1', vorname: 'Freigeber', nachname: 'Eins', email: 'f1@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '2', vorname: 'Freigeber', nachname: 'Zwei', email: 'f2@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '3', vorname: 'Freigeber', nachname: 'Drei', email: 'f3@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '4', vorname: 'Freigeber', nachname: 'Vier', email: 'f4@example.org', gruppen: ['10'], loggedInNow: false });

  // stellvertreter1_id/stellvertreter2_id are NOT NULL FKs to personen (schema.sql) — this test
  // never exercises Stellvertretung, so each Konto simply points its Stellvertreter fields back
  // at its own Freigeber1/Freigeber2 (a valid, harmless FK target that plays no role in the flow).
  const kontoA = createKonto(db, { kontonummer: '6500', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '1', freigeber2Id: '2', stellvertreter2Id: '2' });
  const kontoB = createKonto(db, { kontonummer: '6600', bezeichnung: 'Reinigung', freigeber1Id: '1', stellvertreter1Id: '1', freigeber2Id: '3', stellvertreter2Id: '3' });
  const kontoC = createKonto(db, { kontonummer: '6700', bezeichnung: 'Reparaturen', freigeber1Id: '1', stellvertreter1Id: '1', freigeber2Id: '4', stellvertreter2Id: '4' });
  const freigeber2ByKonto = new Map([[kontoA, { id: 2, vorname: 'Freigeber', nachname: 'Zwei', email: 'f2@example.org', gruppen: ['10'] }], [kontoB, { id: 3, vorname: 'Freigeber', nachname: 'Drei', email: 'f3@example.org', gruppen: ['10'] }], [kontoC, { id: 4, vorname: 'Freigeber', nachname: 'Vier', email: 'f4@example.org', gruppen: ['10'] }]]);

  const pdfPfad = join(dir, 'rechnung.pdf');
  writeFileSync(pdfPfad, await buildPdfFixture(['Rechnung Seite 1']));
  const jobId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'lieferant', absender: 'lief@example.org', dateiname: 'rechnung.pdf', pdfPfad });
  db.prepare("UPDATE jobs SET status = 'zugewiesen', zugewiesen_an = '1' WHERE id = ?").run(jobId);

  const app = createApp({ db, config });
  const p1Agent = await loginAs(app, client, { id: 1, vorname: 'Freigeber', nachname: 'Eins', email: 'f1@example.org', gruppen: ['10'] });
  const aufsplittenToken = await fetchCsrfToken(p1Agent, `/kontierung/${jobId}/aufsplitten`);
  const aufsplittenRes = await p1Agent
    .post(`/kontierung/${jobId}/aufsplitten`)
    .type('form')
    .send({
      gesamtbetrag: '180.00',
      teilKontoId: [String(kontoA), String(kontoB), String(kontoC)],
      teilBetrag: ['60.00', '60.00', '60.00'],
      teilInteressenskonflikt: ['false', 'false', 'false'],
      teilPosition: ['Pos. 1', 'Pos. 2', 'Pos. 3'],
      begruendung: '',
      _csrf: aufsplittenToken,
    });
  assert.equal(aufsplittenRes.status, 302);

  const kinder = listSplitKinder(db, jobId);
  assert.equal(kinder.length, 3);
  assert.ok(kinder.every((k) => k.status === 'freigabe2'), 'auto-granted Freigabe 1 must put every Splitkind straight into freigabe2');

  for (const [i, kind] of kinder.entries()) {
    const freigeber2 = freigeber2ByKonto.get(kind.konto_id);
    const f2Agent = await loginAs(app, client, freigeber2);
    const token = await fetchCsrfToken(f2Agent, `/freigabe2/${kind.id}`);
    const res = await f2Agent.post(`/freigabe2/${kind.id}`).type('form').send({ interessenskonflikt: 'nein', begruendung: '', _csrf: token });
    assert.equal(res.status, 302);

    const parentZwischenstand = getJobById(db, jobId);
    if (i < kinder.length - 1) {
      assert.equal(parentZwischenstand.gruppe_pdf_pfad, null, 'the group must not be exported before every sibling has completed Freigabe 2');
    } else {
      assert.ok(parentZwischenstand.gruppe_pdf_pfad, 'the group must be exported right after the last sibling completes Freigabe 2');
    }
  }

  const abholbereitRes = await request(app).get('/api/n8n/jobs/abholbereit').set('X-API-Key', config.n8nApiKey);
  assert.equal(abholbereitRes.status, 200);
  const gruppenEintraege = abholbereitRes.body.filter((e) => e.id === jobId);
  assert.equal(gruppenEintraege.length, 1, 'exactly one combined group entry, not one per Splitkind');
  assert.equal(gruppenEintraege[0].positionen.length, 3);
  assert.deepEqual(gruppenEintraege[0].positionen.map((p) => p.position).sort(), ['Pos. 1', 'Pos. 2', 'Pos. 3']);
  for (const kind of kinder) {
    assert.ok(!abholbereitRes.body.some((e) => e.id === kind.id), 'Splitkinder must never appear as individual abholbereit entries');
  }

  const parentVorAbholung = getJobById(db, jobId);
  const bestaetigenRes = await request(app).post(`/api/n8n/jobs/${jobId}/abholung-bestaetigen`).set('X-API-Key', config.n8nApiKey);
  assert.equal(bestaetigenRes.status, 200);

  for (const kind of kinder) {
    assert.equal(getJobById(db, kind.id).status, 'abgeholt');
    assert.equal(existsSync(kind.pdf_pfad), false, `Splitkind ${kind.id}'s own PDF must be deleted after Abholung`);
  }
  assert.equal(existsSync(parentVorAbholung.gruppe_pdf_pfad), false, 'the merged Gruppen-PDF must be deleted after Abholung');

  rmSync(dir, { recursive: true, force: true });
  db.close();
});
