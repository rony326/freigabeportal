import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { readFileSync, readdirSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/db/index.js';
import { seedDefaults } from '../../src/db/adminConfigRepo.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createKonto } from '../../src/db/kontenRepo.js';
import { createJob } from '../../src/db/jobsRepo.js';
import { createFreigabe } from '../../src/db/freigabenRepo.js';
import { createApp } from '../../src/app.js';
import { setupMockChurchTools } from '../helpers/mockChurchTools.js';

// Befund 3 (docs/review-frischer-blick-2026-09-29.md): Freigabe-2-Erinnerungen und -Eskalationen
// verlinkten /freigabe2 ohne Job-ID (404). Geprüft wird der Link aus der tatsächlich gerenderten
// und über den Mailer versendeten Nachricht gegen die laufende Anwendung.

const BASE = 'http://portal.example.org';

function testConfig(jobsDir) {
  return {
    sessionSecret: 'test-secret',
    env: 'test',
    churchtools: {
      baseUrl: 'https://ct.example.org',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri: `${BASE}/auth/callback`,
      groupIdBuchhaltung: '10',
      groupIdAdmin: '20',
      syncServiceToken: 'token',
    },
    cronSecret: 'cron-secret',
    n8nApiKey: 'n8n-key',
    publicBaseUrl: BASE,
    brandingDir: jobsDir,
    jobsDir,
    downloadSigningSecret: 'download-secret',
  };
}

function stubMailer() {
  const sent = [];
  return { sent, async sendMail(mail) { sent.push(mail); } };
}

async function loginAs(app, client, { id, vorname, nachname, email, gruppen }) {
  client.intercept({ path: '/oauth/access_token', method: 'POST' }).reply(200, { access_token: `tok-${id}` });
  client.intercept({ path: '/oauth/userinfo', method: 'GET' }).reply(200, { id, firstName: vorname, lastName: nachname, email });
  client.intercept({ path: '/api/groups/10/members', method: 'GET' }).reply(200, { data: gruppen.includes('10') ? [{ personId: id }] : [] });
  client.intercept({ path: '/api/groups/20/members', method: 'GET' }).reply(200, { data: gruppen.includes('20') ? [{ personId: id }] : [] });
  const agent = request.agent(app);
  const loginRes = await agent.get('/auth/login');
  const state = new URL(loginRes.headers.location).searchParams.get('state');
  const callbackRes = await agent.get('/auth/callback').query({ code: `code-${id}`, state });
  assert.equal(callbackRes.status, 302);
  return agent;
}

function linkAus(mail) {
  const treffer = mail.text.match(/https?:\/\/\S+/g) || [];
  const link = treffer.find((url) => url.startsWith(BASE));
  assert.ok(link, `rendered mail must contain a portal link: ${mail.text}`);
  return link.slice(BASE.length);
}

test('Freigabe-2-Erinnerung und -Eskalation verlinken die konkrete, für den Empfänger erreichbare Freigabeseite', async () => {
  const jobsDir = mkdtempSync(join(tmpdir(), 'mail-links-'));
  const db = openDatabase(':memory:');
  seedDefaults(db);
  for (const id of ['1', '2', '3', '4']) upsertPerson(db, { id, vorname: `P${id}`, nachname: 'M', email: `p${id}@example.org`, gruppen: [], loggedInNow: false });
  upsertPerson(db, { id: '99', vorname: 'Ad', nachname: 'Min', email: 'admin@example.org', gruppen: ['20'], loggedInNow: false });
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  const reminderJob = createJob(db, { eingangAm: '2020-01-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'reminder.pdf', pdfPfad: join(jobsDir, 'r.pdf') });
  const eskalationJob = createJob(db, { eingangAm: '2020-01-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'eskalation.pdf', pdfPfad: join(jobsDir, 'e.pdf') });
  const vor30h = new Date(Date.now() - 30 * 3600 * 1000).toISOString();
  db.prepare("UPDATE jobs SET status = 'freigabe2', konto_id = ?, freigabe2_seit = ? WHERE id = ?").run(kontoId, vor30h, reminderJob);
  db.prepare("UPDATE jobs SET status = 'freigabe2', konto_id = ?, freigabe2_seit = '2020-01-01T00:00:00.000Z', freigabe2_reminder_gesendet_at = '2020-01-02T00:00:00.000Z' WHERE id = ?").run(kontoId, eskalationJob);
  for (const jobId of [reminderJob, eskalationJob]) {
    createFreigabe(db, { jobId, personId: '1', rolle: 'freigeber1', zeitpunkt: '2020-01-01T01:00:00.000Z', ip: '127.0.0.1', interessenskonflikt: false, kommentar: null, eskaliertVon: null });
  }

  const client = setupMockChurchTools('https://ct.example.org');
  const mailer = stubMailer();
  const app = createApp({ db, config: testConfig(jobsDir), mailer });

  const lauf = await request(app).post('/internal/cron/freigabe2-erinnerungen').set('X-Cron-Secret', 'cron-secret');
  assert.equal(lauf.status, 200);
  assert.equal(lauf.body.reminder, 1);
  assert.equal(lauf.body.eskalation, 1);

  const reminderMail = mailer.sent.find((m) => m.to === 'p3@example.org');
  const eskalationMail = mailer.sent.find((m) => m.to === 'admin@example.org');
  assert.equal(linkAus(reminderMail), `/freigabe2/${reminderJob}`);
  assert.equal(linkAus(eskalationMail), `/freigabe2/${eskalationJob}`);

  const freigeber2 = await loginAs(app, client, { id: 3, vorname: 'P3', nachname: 'M', email: 'p3@example.org', gruppen: [] });
  const seite1 = await freigeber2.get(linkAus(reminderMail));
  assert.equal(seite1.status, 200, `the reminder link must open the Freigabe-2 page for its recipient: ${seite1.text.slice(0, 2000)}`);
  assert.match(seite1.text, /reminder\.pdf/);

  const admin = await loginAs(app, client, { id: 99, vorname: 'Ad', nachname: 'Min', email: 'admin@example.org', gruppen: ['20'] });
  const seite2 = await admin.get(linkAus(eskalationMail));
  assert.equal(seite2.status, 200, 'the escalation link must open the escalated job for the admin recipient');
  assert.match(seite2.text, /eskalation\.pdf/);

  db.close();
  rmSync(jobsDir, { recursive: true, force: true });
});

// Ursache statt Einzelfall: jeder Mail-Link im Quellcode muss auf eine registrierte GET-Route
// zeigen. Platzhalter wie ${job.id} werden durch eine Beispiel-ID ersetzt.
function jsDateien(dir) {
  return readdirSync(dir).flatMap((name) => {
    const pfad = join(dir, name);
    return statSync(pfad).isDirectory() ? jsDateien(pfad) : pfad.endsWith('.js') ? [pfad] : [];
  });
}

function hatGetRoute(stack, pfad) {
  for (const layer of stack) {
    if (!layer.match(pfad)) continue;
    if (layer.route) {
      if (layer.route.methods.get) return true;
    } else if (layer.handle && Array.isArray(layer.handle.stack)) {
      const rest = pfad.slice(layer.path.length) || '/';
      if (hatGetRoute(layer.handle.stack, rest.startsWith('/') ? rest : `/${rest}`)) return true;
    }
  }
  return false;
}

test('jeder im Quellcode erzeugte Mail-Link zeigt auf eine vorhandene GET-Route', () => {
  const quellen = jsDateien(new URL('../../src', import.meta.url).pathname);
  const pfade = new Set();
  for (const datei of quellen) {
    for (const [, pfad] of readFileSync(datei, 'utf8').matchAll(/\$\{config\.publicBaseUrl\}(\/[^`\s'"]*)/g)) {
      pfade.add(pfad.replace(/\$\{[^}]+\}/g, '1').replace(/\\n.*$/, ''));
    }
  }
  assert.ok(pfade.size >= 10, `expected to find the mail links in src, found ${[...pfade]}`);
  const db = openDatabase(':memory:');
  const app = createApp({ db, config: testConfig(tmpdir()), mailer: stubMailer() });
  const fehlend = [...pfade].filter((pfad) => !hatGetRoute(app._router.stack, pfad));
  assert.deepEqual(fehlend, [], 'mail links without a matching GET route');
  db.close();
});
