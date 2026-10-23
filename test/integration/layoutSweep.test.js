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
import { setBerechtigungenForPerson } from '../../src/db/personBerechtigungenRepo.js';

const viewsDir = new URL('../../views', import.meta.url).pathname;
const adminViewsDir = new URL('../../views/admin', import.meta.url).pathname;

function seitenViews(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.ejs') && !f.startsWith('_'))
    .map((f) => join(dir, f));
}

test('Layout-Sweep: keine View baut ihr Grundgerüst selbst', () => {
  const views = seitenViews(viewsDir);
  assert.ok(views.length >= 17, `erwartet mindestens 17 Views, gefunden ${views.length}`);
  const adminViews = seitenViews(adminViewsDir);
  assert.ok(adminViews.length >= 25, `erwartet mindestens 25 Admin-Views, gefunden ${adminViews.length}`);
  for (const datei of [...views, ...adminViews]) {
    const inhalt = readFileSync(datei, 'utf8');
    for (const verboten of ['<!DOCTYPE', 'container-fluid', "include('_header'", "include('../_header'", "include('./_nav')", 'navContainerClass']) {
      assert.ok(!inhalt.includes(verboten), `${datei} enthält "${verboten}"`);
    }
  }
});

test('Layout-Sweep: jede View beginnt mit genau einem _seite_anfang und endet mit _seite_ende', () => {
  const alle = [
    ...seitenViews(viewsDir).map((datei) => ({ datei, praefix: '' })),
    ...seitenViews(adminViewsDir).map((datei) => ({ datei, praefix: '../' })),
  ];
  for (const { datei, praefix } of alle) {
    const inhalt = readFileSync(datei, 'utf8').trim();
    assert.ok(inhalt.startsWith(`<%- include('${praefix}_seite_anfang'`), `${datei} beginnt nicht mit ${praefix}_seite_anfang`);
    assert.equal(inhalt.split("_seite_anfang'").length - 1, 1, `${datei}: _seite_anfang nicht genau einmal`);
    assert.match(inhalt, new RegExp(`<%- include\\('${praefix.replace('.', '\\.')}_seite_ende'[^%]*%>$`), `${datei} endet nicht mit ${praefix}_seite_ende`);
    // rahmen 'ohne' muss am Anfang und am Ende gleich gesetzt sein (sonst bleibt der Footer stehen bzw. fehlt ein </div>).
    const anfangOhne = /_seite_anfang'[^%]*rahmen:\s*'ohne'/.test(inhalt);
    const endeOhne = /_seite_ende'[^%]*rahmen:\s*'ohne'/.test(inhalt);
    assert.equal(endeOhne, anfangOhne, `${datei}: rahmen 'ohne' in _seite_anfang und _seite_ende nicht gleich`);
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

async function loginBuchhaltung(db, { personId = 1, vorname = 'Buch', nachname = 'Halter', buchhaltung = true, admin = false } = {}) {
  const config = testConfig();
  const client = setupMockChurchTools(config.churchtools.baseUrl);
  client.intercept({ path: '/oauth/access_token', method: 'POST' }).reply(200, { access_token: 'tok' });
  client
    .intercept({ path: '/oauth/userinfo', method: 'GET' })
    .reply(200, { id: personId, firstName: vorname, lastName: nachname, email: 'buch@example.org' });
  client.intercept({ path: '/api/groups/10/members', method: 'GET' }).reply(200, { data: buchhaltung ? [{ personId }] : [] });
  client.intercept({ path: '/api/groups/20/members', method: 'GET' }).reply(200, { data: admin ? [{ personId }] : [] });
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

function reiterUndLeiste(text) {
  const reiter = text.match(/<nav class="portal-reiter[\s\S]*?<\/nav>/);
  const leiste = text.match(/<nav class="portal-seitenleiste[^"]*"[\s\S]*?<\/nav>/);
  assert.ok(reiter, 'Reiter fehlen');
  assert.ok(leiste, 'Seitenleiste fehlt');
  return { reiter: reiter[0], leiste: leiste[0] };
}

test('GET /admin/konten/neu (Superadmin): Konten aktiv, Reiter Admin aktiv, alle 4 Gruppenüberschriften, Titel mit Admin', async () => {
  const db = openDatabase(':memory:');
  const agent = await loginBuchhaltung(db, { personId: 9, vorname: 'Super', nachname: 'Admin', buchhaltung: false, admin: true });
  const res = await agent.get('/admin/konten/neu');
  assert.equal(res.status, 200);
  const { reiter, leiste } = reiterUndLeiste(res.text);
  assert.match(leiste, /<a [^>]*href="\/admin\/konten"[^>]*aria-current="page"/);
  assert.equal(anzahl(leiste, 'aria-current="page"'), 1);
  assert.match(reiter, /<a [^>]*href="\/admin"[^>]*aria-current="page"[^>]*>Admin<\/a>/);
  for (const titel of ['Vorgänge', 'Stammdaten', 'Einstellungen', 'Betrieb']) {
    assert.match(leiste, new RegExp(`portal-gruppe-titel">${titel}<`), `Gruppe ${titel} fehlt`);
  }
  assert.doesNotMatch(res.text, /nav-pills/);
  assert.equal(anzahl(res.text, 'bootstrap.min.css'), 1);
  assert.match(res.text, /<title>Konto — .* Admin<\/title>/);
  db.close();
});

test('GET /admin/mails (nur mails_einsehen): nur Gruppe Betrieb, Reiter Admin vorhanden', async () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '5', vorname: 'Nur', nachname: 'Mails', email: 'buch@example.org', gruppen: [], loggedInNow: false });
  setBerechtigungenForPerson(db, '5', ['mails_einsehen']);
  const agent = await loginBuchhaltung(db, { personId: 5, vorname: 'Nur', nachname: 'Mails', buchhaltung: false });
  const res = await agent.get('/admin/mails');
  assert.equal(res.status, 200);
  const { reiter, leiste } = reiterUndLeiste(res.text);
  assert.equal(anzahl(leiste, 'portal-gruppe-titel'), 1);
  assert.match(leiste, /portal-gruppe-titel">Betrieb</);
  assert.match(leiste, /<a [^>]*href="\/admin\/mails"[^>]*aria-current="page"/);
  assert.match(reiter, /<a [^>]*href="\/admin"[^>]*aria-current="page"[^>]*>Admin<\/a>/);
  db.close();
});

test('GET /admin (Dashboard): Reiter Admin aktiv, kein Seitenleisten-Punkt aktiv, Titel ohne doppeltes Admin', async () => {
  const db = openDatabase(':memory:');
  const agent = await loginBuchhaltung(db, { personId: 9, vorname: 'Super', nachname: 'Admin', buchhaltung: false, admin: true });
  const res = await agent.get('/admin');
  assert.equal(res.status, 200);
  const { reiter, leiste } = reiterUndLeiste(res.text);
  assert.match(reiter, /<a [^>]*href="\/admin"[^>]*aria-current="page"[^>]*>Admin<\/a>/);
  assert.equal(anzahl(leiste, 'aria-current'), 0);
  assert.match(res.text, /<title>Übersicht — [^<]* Admin<\/title>/);
  db.close();
});
