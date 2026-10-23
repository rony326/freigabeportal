// Gemeinsames Grundgerüst (views/_seite_anfang.ejs + views/_seite_ende.ejs): ein statischer Sweep
// über alle Nicht-Partial-Views und Render-Prüfungen gegen die echte App.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { setupMockChurchTools } from '../helpers/mockChurchTools.js';
import { openDatabase } from '../../src/db/index.js';
import { createApp } from '../../src/app.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createKonto } from '../../src/db/kontenRepo.js';
import { createJob, claimJob } from '../../src/db/jobsRepo.js';

const viewsDir = new URL('../../views', import.meta.url).pathname;

function seitenViews(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.ejs') && !f.startsWith('_'))
    .map((f) => join(dir, f));
}

test('Layout-Sweep: keine View baut ihr Grundgerüst selbst', () => {
  const views = seitenViews(viewsDir);
  assert.ok(views.length >= 17, `erwartet mindestens 17 Views, gefunden ${views.length}`);
  for (const datei of views) {
    const inhalt = readFileSync(datei, 'utf8');
    for (const verboten of ['<!DOCTYPE', 'container-fluid', "include('_header'", "include('../_header'", 'navContainerClass']) {
      assert.ok(!inhalt.includes(verboten), `${datei} enthält "${verboten}"`);
    }
  }
});

test('Layout-Sweep: jede View beginnt mit genau einem _seite_anfang und endet mit _seite_ende', () => {
  for (const datei of seitenViews(viewsDir)) {
    const inhalt = readFileSync(datei, 'utf8').trim();
    assert.ok(inhalt.startsWith("<%- include('_seite_anfang'"), `${datei} beginnt nicht mit _seite_anfang`);
    assert.equal(inhalt.split("include('_seite_anfang'").length - 1, 1, `${datei}: _seite_anfang nicht genau einmal`);
    assert.match(inhalt, /<%- include\('_seite_ende'[^%]*%>$/, `${datei} endet nicht mit _seite_ende`);
  }
});

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
    },
    n8nApiKey: 'test-n8n-key',
    downloadSigningSecret: 'test-signing-secret',
    jobsDir: '/tmp/freigabeportal-layout-test-jobs',
  };
}

async function loginBuchhaltung(db) {
  const config = testConfig();
  const client = setupMockChurchTools(config.churchtools.baseUrl);
  client.intercept({ path: '/oauth/access_token', method: 'POST' }).reply(200, { access_token: 'tok' });
  client
    .intercept({ path: '/oauth/userinfo', method: 'GET' })
    .reply(200, { id: 1, firstName: 'Buch', lastName: 'Halter', email: 'buch@example.org' });
  client.intercept({ path: '/api/groups/10/members', method: 'GET' }).reply(200, { data: [{ personId: 1 }] });
  client.intercept({ path: '/api/groups/20/members', method: 'GET' }).reply(200, { data: [] });
  const app = createApp({ db, config });
  const agent = request.agent(app);
  const loginRes = await agent.get('/auth/login');
  const state = new URL(loginRes.headers.location).searchParams.get('state');
  await agent.get('/auth/callback').query({ code: 'the-code', state });
  return agent;
}

function seedKontierungsJob(db) {
  upsertPerson(db, { id: '1', vorname: 'Buch', nachname: 'Halter', email: 'buch@example.org', gruppen: ['10'], loggedInNow: false });
  for (const id of ['2', '3']) {
    upsertPerson(db, { id, vorname: `Person${id}`, nachname: 'Muster', email: `p${id}@example.org`, gruppen: [], loggedInNow: false });
  }
  createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '2' });
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, jobId, '1');
  return jobId;
}

function anzahl(text, teil) {
  return text.split(teil).length - 1;
}

test('GET /pool rendert das volle Grundgerüst: Bootstrap genau einmal, container-xxl, Seitenleiste, Reiter Portal aktiv, kein Admin-Reiter', async () => {
  const db = openDatabase(':memory:');
  const agent = await loginBuchhaltung(db);
  const res = await agent.get('/pool');
  assert.equal(res.status, 200);
  assert.equal(anzahl(res.text, 'bootstrap.min.css'), 1);
  assert.equal(anzahl(res.text, 'bootstrap.bundle.min.js'), 1);
  assert.match(res.text, /class="container-xxl/);
  assert.match(res.text, /<header class="portal-kopf/);
  const seitenleiste = res.text.match(/<nav class="portal-seitenleiste[^"]*"[\s\S]*?<\/nav>/);
  assert.ok(seitenleiste, 'nav.portal-seitenleiste fehlt');
  assert.match(seitenleiste[0], /<a [^>]*href="\/pool"[^>]*aria-current="page"/);
  assert.equal(anzahl(seitenleiste[0], 'aria-current="page"'), 1);
  assert.doesNotMatch(seitenleiste[0], /eingeklappt/);
  const reiter = res.text.match(/<nav class="portal-reiter[\s\S]*?<\/nav>/);
  assert.ok(reiter, 'Reiter fehlen');
  assert.match(reiter[0], /<a [^>]*href="\/pool"[^>]*aria-current="page"[^>]*>Portal<\/a>/);
  assert.doesNotMatch(reiter[0], /href="\/admin"/);
  assert.match(res.text, /id="seitenleiste-toggle"/);
  assert.match(res.text, /<script src="\/js\/portal\.js" defer><\/script>/);
  assert.match(res.text, /<link rel="stylesheet" href="\/css\/portal\.css">/);
  assert.match(res.text, /<title>Aufgaben — /);
  db.close();
});

test('GET /kontierung/:id: eingeklappte Seitenleiste und Aktionszeile Zurück → Vorschau neu laden → + Lieferant', async () => {
  const db = openDatabase(':memory:');
  const jobId = seedKontierungsJob(db);
  const agent = await loginBuchhaltung(db);
  const res = await agent.get(`/kontierung/${jobId}`);
  assert.equal(res.status, 200);
  assert.match(res.text, /<nav class="portal-seitenleiste eingeklappt/);
  assert.match(res.text, /<a [^>]*href="\/pool"[^>]*title="Aufgaben"[^>]*aria-label="Aufgaben"/);
  const aktionen = res.text.match(/<div class="portal-aktionen[^"]*">[\s\S]*?<\/div>/);
  assert.ok(aktionen, '.portal-aktionen fehlt');
  const zurueck = aktionen[0].indexOf('<a href="/pool" class="btn btn-primary btn-sm">← Zurück</a>');
  const neuLaden = aktionen[0].indexOf('id="preview-refresh-btn"');
  const lieferant = aktionen[0].indexOf('data-bs-target="#neuer-lieferant-modal"');
  assert.ok(zurueck >= 0 && neuLaden > zurueck && lieferant > neuLaden, 'Reihenfolge Zurück → Vorschau neu laden → + Lieferant');
  db.close();
});

test('GET /auth/abgemeldet ohne Session: container-xxl, keine Seitenleiste, kein ☰-Knopf', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, config: testConfig() });
  const res = await request(app).get('/auth/abgemeldet');
  assert.equal(res.status, 200);
  assert.match(res.text, /class="container-xxl/);
  assert.doesNotMatch(res.text, /portal-seitenleiste/);
  assert.doesNotMatch(res.text, /seitenleiste-toggle/);
  assert.doesNotMatch(res.text, /portal-reiter/);
  db.close();
});

test('404-Fehlerseite ohne Session: Status 404, container-xxl, keine Seitenleiste, kein ☰-Knopf', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, config: testConfig() });
  const res = await request(app).get('/gibt-es-nicht-xyz');
  assert.equal(res.status, 404);
  assert.match(res.text, /class="container-xxl/);
  assert.doesNotMatch(res.text, /portal-seitenleiste/);
  assert.doesNotMatch(res.text, /seitenleiste-toggle/);
  db.close();
});

test('Aufsplitten-View (iframe im Modal) rendert ohne Kopfleiste und ohne Footer', async () => {
  const db = openDatabase(':memory:');
  const jobId = seedKontierungsJob(db);
  const agent = await loginBuchhaltung(db);
  const res = await agent.get(`/kontierung/${jobId}/aufsplitten`);
  assert.equal(res.status, 200);
  assert.doesNotMatch(res.text, /portal-kopf/);
  assert.doesNotMatch(res.text, /<footer/);
  assert.doesNotMatch(res.text, /portal-seitenleiste/);
  assert.match(res.text, /<main class="container-xxl py-3">/);
  assert.equal(anzahl(res.text, 'bootstrap.min.css'), 1);
  db.close();
});
