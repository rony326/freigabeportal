// Fachliche Korrektur Kreditoren statt Debitoren ueber die echte createApp-Verdrahtung:
// Anlage/Anzeige unter korrekter Bezeichnung, Weiterleitung frueherer Pfade, alte Formularfelder
// und Ablehnung widerspruechlicher Eingaben.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../../src/db/index.js';
import { createApp } from '../../../src/app.js';
import { setBerechtigungenForPerson } from '../../../src/db/personBerechtigungenRepo.js';
import { setupMockChurchTools } from '../../helpers/mockChurchTools.js';
import { fetchCsrfToken } from '../../helpers/csrf.js';

function testConfig(dir) {
  return {
    sessionSecret: 'test-secret', env: 'test',
    churchtools: { baseUrl: 'https://ct.example.org', clientId: 'id', clientSecret: 'secret', redirectUri: 'https://portal.example.org/auth/callback', groupIdBuchhaltung: '10', groupIdAdmin: '20', syncServiceToken: 'token' },
    cronSecret: 'cron-secret', n8nApiKey: 'n8n-key',
    smtp: { host: 'smtp.example.org', port: 587, user: 'user', pass: 'pass', from: 'portal@example.org' },
    brandingDir: dir, jobsDir: dir, backupDir: dir, downloadSigningSecret: 'download-secret',
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

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'kreditoren-kompat-'));
  const db = openDatabase(':memory:');
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const config = testConfig(dir);
  return { db, app: createApp({ db, config }), client: setupMockChurchTools(config.churchtools.baseUrl) };
}

test('Kreditoren are created and listed under the correct name; the former path redirects', async (t) => {
  const { db, app, client } = setup(t);
  const admin = await loginAs(app, client, 1, ['20']);
  const token = await fetchCsrfToken(admin, '/admin/kreditoren');
  assert.equal((await admin.post('/admin/kreditoren').type('form').send({ _csrf: token, name: 'Papier AG' })).status, 302);
  const liste = await admin.get('/admin/kreditoren');
  assert.equal(liste.status, 200);
  assert.match(liste.text, /<h1>Kreditoren<\/h1>/);
  assert.match(liste.text, /Papier AG/);
  assert.doesNotMatch(liste.text, /Debitor/);
  const dashboard = await admin.get('/admin');
  assert.match(dashboard.text, /href="\/admin\/kreditoren"/);
  assert.doesNotMatch(dashboard.text, /Debitor/);

  const alt = await admin.get('/admin/debitoren?gespeichert=1');
  assert.equal(alt.status, 301);
  assert.equal(alt.headers.location, '/admin/kreditoren?gespeichert=1');
  const altPost = await admin.post('/admin/debitoren/regeln').type('form').send({ _csrf: token });
  assert.equal(altPost.status, 308);
  assert.equal(altPost.headers.location, '/admin/kreditoren/regeln');
  // The redirect grants nothing: anonymous callers are still stopped by the admin guard first.
  assert.equal((await request(app).get('/admin/debitoren')).status, 401);
  assert.equal(db.prepare('SELECT name FROM kreditoren').get().name, 'Papier AG');
});

test('legacy debitorId form fields still work; contradicting values are rejected without changes', async (t) => {
  const { db, app, client } = setup(t);
  const admin = await loginAs(app, client, 1, ['20']);
  const token = await fetchCsrfToken(admin, '/admin/kreditoren');
  await admin.post('/admin/kreditoren').type('form').send({ _csrf: token, name: 'A AG' });
  await admin.post('/admin/kreditoren').type('form').send({ _csrf: token, name: 'B AG' });
  const [a, b] = db.prepare('SELECT id FROM kreditoren ORDER BY id').all().map((r) => r.id);

  assert.equal((await admin.post('/admin/kreditoren/regeln').type('form').send({ _csrf: token, absenderMuster: 'a.example', debitorId: String(a) })).status, 302);
  assert.equal(db.prepare("SELECT kreditor_id FROM zuweisungsregeln WHERE absender_muster = 'a.example'").get().kreditor_id, a);
  const konflikt = await admin.post('/admin/kreditoren/regeln').type('form').send({ _csrf: token, absenderMuster: 'b.example', kreditorId: String(a), debitorId: String(b) });
  assert.equal(konflikt.status, 400);
  assert.equal(db.prepare("SELECT count(*) AS n FROM zuweisungsregeln WHERE absender_muster = 'b.example'").get().n, 0);
  const ibanKonflikt = await admin.post('/admin/kreditoren/ibans').type('form').send({ _csrf: token, iban: 'CH9300762011623852957', kreditorId: String(a), debitorId: String(b) });
  assert.equal(ibanKonflikt.status, 400);
  assert.equal(db.prepare('SELECT count(*) AS n FROM kreditor_ibans').get().n, 0);
  assert.equal((await admin.post('/admin/kreditoren/ibans').type('form').send({ _csrf: token, iban: 'CH9300762011623852957', kreditorId: String(b) })).status, 302);
  assert.equal(db.prepare('SELECT kreditor_id FROM kreditor_ibans').get().kreditor_id, b);
});

test('the renamed right grants exactly the Kreditoren area', async (t) => {
  const { db, app, client } = setup(t);
  const person = await loginAs(app, client, 7, []);
  setBerechtigungenForPerson(db, '7', ['kreditoren_verwalten']);
  assert.equal((await person.get('/admin/kreditoren')).status, 200);
  assert.equal((await person.get('/admin/konten')).status, 403);
  assert.throws(() => setBerechtigungenForPerson(db, '7', ['debitoren_verwalten']), /CHECK/);
});

test('a personen form loaded before the rename keeps the Kreditoren right instead of silently dropping it', async (t) => {
  const { db, app, client } = setup(t);
  const admin = await loginAs(app, client, 1, ['20']);
  await loginAs(app, client, 7, []);
  const token = await fetchCsrfToken(admin, '/admin/personen');
  const res = await admin.post('/admin/personen/7/berechtigungen').type('form')
    .send({ _csrf: token, berechtigungen: ['debitoren_verwalten', 'kreditoren_verwalten', 'mails_einsehen'] });
  assert.equal(res.status, 302);
  assert.deepEqual(db.prepare("SELECT berechtigung FROM person_berechtigungen WHERE person_id = '7' ORDER BY berechtigung").all().map((r) => r.berechtigung),
    ['kreditoren_verwalten', 'mails_einsehen']);
});
