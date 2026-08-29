import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createKonto } from '../../src/db/kontenRepo.js';
import { createZuweisungsregel } from '../../src/db/zuweisungsregelnRepo.js';
import { createDebitor } from '../../src/db/debitorenRepo.js';
import { seedDefaults } from '../../src/db/adminConfigRepo.js';
import { listMailLog } from '../../src/db/mailLogRepo.js';
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
    },
    cronSecret: 'cron-secret',
    n8nApiKey: 'n8n-key',
    // Deliberately unresolvable (no DNS record) — proves the app's real, non-test-only fallback
    // path (Task 3's try/catch around createMailer, plus sendNotification's own catch) handles
    // every attempt gracefully, exactly as it would with a genuinely misconfigured production
    // SMTP server. A hostname with no A/AAAA record fails fast via DNS ENOTFOUND, unlike a raw
    // unreachable IP which would block on a multi-minute TCP connection timeout — matching the
    // same host used by the pre-existing freigabeWorkflowEndToEnd/ablehnungRueckwegEndToEnd tests.
    smtp: { host: 'smtp.example.org', port: 587, user: 'u', pass: 'p', from: 'portal@example.org' },
    // http, not https: this test drives real login round-trips through supertest's in-process
    // agent, which — correctly, matching real browser behavior — will not resend a cookie the
    // server marked Secure back over a connection it doesn't consider secure (supertest always
    // talks plain HTTP internally). A Secure-cookie round-trip is instead covered directly,
    // without a multi-request round-trip, in test/integration/app.test.js.
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

test('every Zuweisungs-Mail trigger across the full workflow logs a mail_log attempt, admin can view and retry', async () => {
  const db = openDatabase(':memory:');
  const jobsDir = mkdtempSync(join(tmpdir(), 'mailversand-e2e-test-'));
  const config = testConfig(jobsDir);
  const app = createApp({ db, config });
  const client = setupMockChurchTools(config.churchtools.baseUrl);
  seedDefaults(db);

  upsertPerson(db, { id: '1', vorname: 'Freigeber', nachname: 'Eins', email: 'f1@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '2', vorname: 'Stellvertreter', nachname: 'Eins', email: 's1@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '3', vorname: 'Freigeber', nachname: 'Zwei', email: 'f2@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '4', vorname: 'Stellvertreter', nachname: 'Zwei', email: 's2@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '99', vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'], loggedInNow: false });
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  const debitorId = createDebitor(db, { name: 'Muster AG', kontoId });
  createZuweisungsregel(db, { absenderMuster: 'lieferant.ch', debitorId });

  // 1. Job creation with a matching Zuweisungsregel -> auto-assignment mail to freigeber1.
  const pdf = await buildPdfFixture(['Rechnung Seite 1', 'Visum / Rechnungsfreigabe']);
  const createRes = await request(app)
    .post('/api/n8n/jobs')
    .set('X-API-Key', 'n8n-key')
    .field('quelle', 'lieferant')
    .field('absender', 'rechnungen@lieferant.ch')
    .field('dateiname', 'rechnung.pdf')
    .attach('pdf', pdf, { filename: 'rechnung.pdf', contentType: 'application/pdf' });
  assert.equal(createRes.status, 201);
  const jobId = createRes.body.id;

  // 2. Freigeber 1 declares a conflict -> escalation mail to stellvertreter1.
  const freigeber1Agent = await loginAs(app, client, { id: 1, vorname: 'Freigeber', nachname: 'Eins', email: 'f1@example.org', gruppen: ['10'] });
  const freigeber1Token = await fetchCsrfToken(freigeber1Agent, '/pool');
  await freigeber1Agent.post(`/kontierung/${jobId}`).type('form').send({ kontoId: String(kontoId), debitorId: String(debitorId), absender: 'Muster AG', rechnungsnummer: 'RE-1', betrag: '100.00', zahlungsziel: '2026-09-01', interessenskonflikt: 'ja', begruendung: 'Befangen', _csrf: freigeber1Token });

  // 3. Stellvertreter 1 completes Kontierung + Freigabe 1 -> handoff mail to freigeber2.
  const stellvertreter1Agent = await loginAs(app, client, { id: 2, vorname: 'Stellvertreter', nachname: 'Eins', email: 's1@example.org', gruppen: ['10'] });
  const stellvertreter1Token = await fetchCsrfToken(stellvertreter1Agent, '/pool');
  await stellvertreter1Agent.post(`/kontierung/${jobId}`).type('form').send({ kontoId: String(kontoId), debitorId: String(debitorId), absender: 'Muster AG', rechnungsnummer: 'RE-1', betrag: '100.00', zahlungsziel: '2026-09-01', interessenskonflikt: 'nein', begruendung: '', _csrf: stellvertreter1Token });

  // 4. Freigeber 2 declares a conflict -> escalation mail to stellvertreter2.
  const freigeber2Agent = await loginAs(app, client, { id: 3, vorname: 'Freigeber', nachname: 'Zwei', email: 'f2@example.org', gruppen: ['10'] });
  const freigeber2Token = await fetchCsrfToken(freigeber2Agent, '/pool');
  await freigeber2Agent.post(`/freigabe2/${jobId}`).type('form').send({ interessenskonflikt: 'ja', begruendung: 'Auch befangen', _csrf: freigeber2Token });

  // 5. Stellvertreter 2 rejects -> Ablehnungs-Benachrichtigung to the job owner (stellvertreter1, '2').
  const stellvertreter2Agent = await loginAs(app, client, { id: 4, vorname: 'Stellvertreter', nachname: 'Zwei', email: 's2@example.org', gruppen: ['10'] });
  const stellvertreter2Token = await fetchCsrfToken(stellvertreter2Agent, '/pool');
  await stellvertreter2Agent.post(`/freigabe2/${jobId}`).type('form').send({ aktion: 'ablehnen', interessenskonflikt: 'nein', begruendung: 'Falsches Konto', _csrf: stellvertreter2Token });

  const zuweisungMails = listMailLog(db).filter((m) => m.typ === 'zuweisung' && m.job_id === jobId);
  const ablehnungMails = listMailLog(db).filter((m) => m.typ === 'ablehnung' && m.job_id === jobId);
  // 4, not 3: auto-assignment (step 1) + F1-escalation-to-stellvertreter1 (step 2) +
  // F1-completion-handoff-to-freigeber2 (step 3, the non-conflict branch also sends a
  // typ='zuweisung' mail) + F2-escalation-to-stellvertreter2 (step 4).
  assert.equal(zuweisungMails.length, 4, 'auto-assignment + F1-escalation + F1-completion-handoff + F2-escalation');
  assert.equal(zuweisungMails.filter((m) => m.empfaenger === 'f1@example.org').length, 1);
  assert.equal(zuweisungMails.filter((m) => m.empfaenger === 's1@example.org').length, 1);
  assert.equal(zuweisungMails.filter((m) => m.empfaenger === 'f2@example.org').length, 1);
  assert.equal(zuweisungMails.filter((m) => m.empfaenger === 's2@example.org').length, 1);
  assert.equal(ablehnungMails.length, 1);
  assert.match(ablehnungMails[0].text, /Falsches Konto/);
  assert.equal(ablehnungMails[0].empfaenger, 's1@example.org', 'notifies the current job owner (stellvertreter1), not the original freigeber1');

  // 6. Reminder/Eskalation sweep against a separately-seeded, very stale, still-unclaimed job.
  // Uses its own PDF fixture, not the step-1 one: byte-identical content would now be treated as
  // a duplicate resubmission of the same document (see the n8n duplicate-detection feature) and
  // short-circuit to the existing job instead of creating this scenario's own fresh job.
  const stalePdf = await buildPdfFixture(['Ganz andere alte Rechnung']);
  const staleJobRes = await request(app)
    .post('/api/n8n/jobs')
    .set('X-API-Key', 'n8n-key')
    .field('quelle', 'scanner')
    .field('dateiname', 'altfall.pdf')
    .field('eingang_am', '2020-01-01T00:00:00.000Z')
    .attach('pdf', stalePdf, { filename: 'altfall.pdf', contentType: 'application/pdf' });
  assert.equal(staleJobRes.status, 201);

  const sweepRes1 = await request(app).post('/internal/cron/pool-erinnerungen').set('X-Cron-Secret', 'cron-secret');
  assert.equal(sweepRes1.status, 200);
  assert.equal(sweepRes1.body.reminder, 1);
  assert.equal(sweepRes1.body.eskalation, 1);

  const sweepRes2 = await request(app).post('/internal/cron/pool-erinnerungen').set('X-Cron-Secret', 'cron-secret');
  assert.equal(sweepRes2.status, 200);
  assert.equal(sweepRes2.body.reminder, 0, 'idempotent: the same stale job is not reminded twice');
  assert.equal(sweepRes2.body.eskalation, 0);

  // 7. Every attempt above targeted an unreachable SMTP host -> all fehlgeschlagen. Admin views
  // the log and retries one -> a new fehlgeschlagen row is appended (proves the retry path
  // itself runs sendNotification again, without requiring a working SMTP server in this test).
  const allMails = listMailLog(db);
  assert.ok(allMails.length >= 6, 'zuweisung x4 + ablehnung x1 + reminder x1 + eskalation x1');
  assert.ok(allMails.every((m) => m.status === 'fehlgeschlagen'), 'unreachable SMTP host: every attempt failed, none crashed the app');

  const adminAgent = await loginAs(app, client, { id: 99, vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'] });
  const adminToken = await fetchCsrfToken(adminAgent, '/pool');
  const listRes = await adminAgent.get('/admin/mails');
  assert.equal(listRes.status, 200);
  assert.match(listRes.text, /Falsches Konto|Rechnung abgelehnt/);

  const countBeforeRetry = listMailLog(db).length;
  const retryRes = await adminAgent.post(`/admin/mails/${ablehnungMails[0].id}/erneut-versenden`).type('form').send({ _csrf: adminToken });
  assert.equal(retryRes.status, 302);
  assert.equal(listMailLog(db).length, countBeforeRetry + 1, 'retry appends a new row rather than overwriting the original');

  db.close();
  rmSync(jobsDir, { recursive: true, force: true });
});
