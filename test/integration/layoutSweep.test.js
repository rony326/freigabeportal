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

// ---------- Einheitlicher Seitenaufbau: Seitenkopf → Meldungen → Filterzeile → Inhalt ----------

function alleSeitenViews() {
  return [...seitenViews(viewsDir), ...seitenViews(adminViewsDir)];
}

function rahmenOhne(inhalt) {
  return /_seite_anfang'[^%]*rahmen:\s*'ohne'/.test(inhalt);
}

test('Seitenaufbau-Sweep: jede View mit Rahmen voll/kompakt hat genau ein h1, und zwar als h1.seitenkopf-titel im .seitenkopf', () => {
  for (const datei of alleSeitenViews()) {
    const inhalt = readFileSync(datei, 'utf8');
    if (rahmenOhne(inhalt)) continue;
    assert.equal(anzahl(inhalt, '<h1'), 1, `${datei}: nicht genau ein <h1`);
    assert.match(inhalt, /<div class="seitenkopf">\s*<h1 class="seitenkopf-titel">/, `${datei}: <h1> steht nicht als h1.seitenkopf-titel im .seitenkopf`);
  }
});

test('Seitenaufbau-Sweep: der Seitenkopf ist das erste Element nach _seite_anfang', () => {
  for (const datei of alleSeitenViews()) {
    const inhalt = readFileSync(datei, 'utf8');
    if (rahmenOhne(inhalt)) continue;
    const nachAnfang = inhalt.slice(inhalt.indexOf('%>', inhalt.indexOf("_seite_anfang'")) + 2);
    // Reine EJS-Anweisungen (<% … %>, keine Ausgabe) dürfen davor stehen.
    const ersteAusgabe = nachAnfang.replace(/^(\s*<%(?![-=])[\s\S]*?%>)*\s*/, '');
    assert.ok(ersteAusgabe.startsWith('<div class="seitenkopf">'), `${datei}: Seitenkopf ist nicht das erste Element`);
  }
});

test('Seitenaufbau-Sweep: keine View enthält <h1 class="h3"', () => {
  for (const datei of alleSeitenViews()) {
    assert.ok(!readFileSync(datei, 'utf8').includes('<h1 class="h3"'), `${datei} enthält <h1 class="h3"`);
  }
});

test('Seitenaufbau-Sweep: Unterüberschriften sind einheitlich h2.h5 (auch in Partials)', () => {
  const alle = [viewsDir, adminViewsDir].flatMap((dir) => readdirSync(dir).filter((f) => f.endsWith('.ejs')).map((f) => join(dir, f)));
  for (const datei of alle) {
    const inhalt = readFileSync(datei, 'utf8');
    for (const h2 of inhalt.match(/<h2\b[^>]*>/g) || []) {
      assert.match(h2, /^<h2 class="h5[ "]/, `${datei}: ${h2} ist nicht h2.h5`);
    }
    assert.doesNotMatch(inhalt, /<h[346]\b/, `${datei}: Überschrift h3/h4/h6 statt h2.h5`);
  }
});

test('Seitenaufbau-Sweep: GET-Filterformulare sind .filterzeile und stehen nach Seitenkopf und Meldungen', () => {
  for (const datei of alleSeitenViews()) {
    const inhalt = readFileSync(datei, 'utf8');
    for (const form of inhalt.match(/<form\b[^>]*method="get"[^>]*>/gi) || []) {
      assert.match(form, /class="filterzeile[ "]/, `${datei}: ${form} ist keine .filterzeile`);
    }
    const filter = inhalt.indexOf('class="filterzeile');
    if (filter < 0) continue;
    assert.ok(inhalt.indexOf('class="seitenkopf"') < filter, `${datei}: Filterzeile vor dem Seitenkopf`);
    const meldung = inhalt.indexOf('class="alert');
    if (meldung >= 0) assert.ok(meldung < filter, `${datei}: Meldung nach der Filterzeile`);
  }
});

test('Seitenaufbau-Sweep: der Seitenkopf hat genau ein btn-primary (die Hauptaktion), und zwar btn-sm', () => {
  for (const datei of alleSeitenViews()) {
    const inhalt = readFileSync(datei, 'utf8');
    const kopf = inhalt.match(/<div class="seitenkopf">[\s\S]*?<\/h1>\s*(<div class="seitenkopf-aktionen">[\s\S]*?<\/div>)?/);
    if (!kopf || !kopf[1]) continue;
    for (const knopf of kopf[1].match(/class="btn [^"]*"/g) || []) {
      if (knopf.includes('btn-primary')) assert.match(knopf, /btn btn-primary btn-sm/, `${datei}: Hauptaktion nicht btn-primary btn-sm`);
    }
    assert.ok(anzahl(kopf[1], 'btn-primary') <= 1, `${datei}: mehr als eine Hauptaktion im Seitenkopf`);
  }
});

test('GET /admin/konten: Seitenkopf mit Titel und Hauptaktion „Neues Konto anlegen“, danach die Meldung', async () => {
  const db = openDatabase(':memory:');
  const agent = await loginBuchhaltung(db, { personId: 9, vorname: 'Super', nachname: 'Admin', buchhaltung: false, admin: true });
  const res = await agent.get('/admin/konten?gespeichert=1');
  assert.equal(res.status, 200);
  const main = res.text.slice(res.text.indexOf('<main'));
  const kopf = main.match(/<div class="seitenkopf">\s*<h1 class="seitenkopf-titel">Konten<\/h1>\s*<div class="seitenkopf-aktionen">([\s\S]*?)<\/div>/);
  assert.ok(kopf, 'Seitenkopf mit Titel Konten und Aktionen fehlt');
  assert.match(kopf[1], /<a href="\/admin\/konten\/neu" class="btn btn-primary btn-sm">Neues Konto anlegen<\/a>/);
  assert.equal(anzahl(main, 'Neues Konto anlegen'), 1);
  assert.equal(anzahl(res.text, '<h1'), 1);
  assert.ok(main.indexOf('class="alert alert-success') > main.indexOf('<div class="seitenkopf">'), 'Meldung steht nach dem Seitenkopf');
  db.close();
});

test('GET /admin/vorgaenge: Reihenfolge Seitenkopf → Filterzeile → Inhalt', async () => {
  const db = openDatabase(':memory:');
  const agent = await loginBuchhaltung(db, { personId: 9, vorname: 'Super', nachname: 'Admin', buchhaltung: false, admin: true });
  const res = await agent.get('/admin/vorgaenge');
  assert.equal(res.status, 200);
  const kopf = res.text.indexOf('<div class="seitenkopf">');
  const filter = res.text.indexOf('<form method="get" action="/admin/vorgaenge" class="filterzeile');
  const inhalt = res.text.indexOf('Keine laufenden Vorgänge');
  assert.ok(kopf >= 0 && filter > kopf && inhalt > filter, 'Reihenfolge Seitenkopf → Filterzeile → Inhalt');
  db.close();
});

// ---------- portal.css: statische Prüfungen für schmale und niedrige Bildschirme ----------

const portalCss = () => readFileSync(new URL('../../public/css/portal.css', import.meta.url), 'utf8');

function cssRegel(css, selektor) {
  const start = css.indexOf(`${selektor} {`);
  assert.ok(start >= 0, `Regel ${selektor} fehlt`);
  return css.slice(start, css.indexOf('}', start));
}

test('portal.css: obere Leiste schrumpft auf Telefonbreite (minmax(0,1fr), Titel mit Ellipse)', () => {
  const css = portalCss();
  assert.match(cssRegel(css, '.portal-kopf-zeile'), /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto\s+minmax\(0,\s*1fr\)/);
  const titel = cssRegel(css, '.portal-kopf-titel');
  assert.match(titel, /min-width:\s*0/);
  assert.match(titel, /overflow:\s*hidden/);
  assert.match(titel, /text-overflow:\s*ellipsis/);
  assert.match(cssRegel(css, '.portal-kopf-links'), /min-width:\s*0/);
  assert.match(css, /\.portal-kopf-zeile img\s*\{[^}]*max-width:\s*100%/);
});

test('portal.css: Zuweisen-Formular in Kacheln bleibt innerhalb der Kachel', () => {
  const css = portalCss();
  const form = cssRegel(css, '.kachel .zuweisen-form');
  assert.match(form, /display:\s*flex/);
  assert.match(form, /width:\s*100%/);
  const select = cssRegel(css, '.kachel .zuweisen-form select');
  assert.match(select, /flex:\s*1 1 0/);
  assert.match(select, /min-width:\s*0/);
  assert.match(select, /width:\s*auto\s*!important/);
});

test('portal.css: klebende Seitenleiste ist höchstens bildschirmhoch und scrollt selbst', () => {
  const css = portalCss();
  const sticky = css.match(/@media \(min-width: 992px\) \{\s*\.portal-seitenleiste \{[^}]*\}/);
  assert.ok(sticky, 'Sticky-Regel der Seitenleiste fehlt');
  assert.match(sticky[0], /position:\s*sticky/);
  assert.match(sticky[0], /max-height:\s*calc\(100vh - [^)]+\)/);
  assert.match(sticky[0], /overflow-y:\s*auto/);
});

test('PDF-Seiten: PDF und Formular füllen ab lg die ganze Zeile (keine Zentrierlücke)', () => {
  for (const name of ['kontierung.ejs', 'freigabe2.ejs', 'spesen-freigabe1.ejs']) {
    const inhalt = readFileSync(join(viewsDir, name), 'utf8');
    assert.doesNotMatch(inhalt, /justify-content-center/, `${name}: zentrierte Zeile lässt Breite leer`);
    assert.doesNotMatch(inhalt, /col-xl-\d/, `${name}: eigene xl-Spaltenbreite lässt Breite leer`);
    // PDF-Spalte über das Partial _beleg_umschalter (spalte: 'col-lg-N'), Formularspalte danach.
    const pdf = inhalt.match(/include\('_beleg_umschalter', \{[^\n]*?spalte: 'col-lg-(\d+)'/);
    assert.ok(pdf, `${name}: PDF-Spalte fehlt`);
    const formular = inhalt.slice(pdf.index + pdf[0].length).match(/<div class="col-lg-(\d+) beleg-umschalter-formular"(?: id="beleg-umschalter-formular")?>/);
    assert.ok(formular, `${name}: Formularspalte fehlt`);
    assert.equal(Number(pdf[1]) + Number(formular[1]), 12, `${name}: PDF + Formular ≠ 12 Spalten`);
  }
});

test('portal.css: beim Drucken der Prüfbescheinigung entfällt der Seitenkopf (Titel steht im Kasten)', () => {
  const druck = portalCss().slice(portalCss().indexOf('@media print'));
  assert.match(druck, /body:has\(\.bescheinigung\) \.seitenkopf[,\s][^{]*\{[^}]*display:\s*none/);
});

test('Tabellen-Sweep: jede <table> steckt direkt in einem div.table-responsive (kein seitliches Verschieben auf dem Handy)', () => {
  const alle = [viewsDir, adminViewsDir].flatMap((dir) => readdirSync(dir).filter((f) => f.endsWith('.ejs')).map((f) => join(dir, f)));
  for (const datei of alle) {
    const inhalt = readFileSync(datei, 'utf8');
    let pos = inhalt.indexOf('<table');
    while (pos >= 0) {
      const davor = inhalt.slice(0, pos).trimEnd();
      assert.match(davor, /<div class="table-responsive[^"]*">$/, `${datei}: <table an Zeichen ${pos} ohne div.table-responsive`);
      pos = inhalt.indexOf('<table', pos + 1);
    }
  }
});

test('Roh-Ausgabe-Sweep: HTML-Bausteine in <% %>-Helfern interpolieren nur include()-Ergebnisse und feste Klassen', () => {
  // Hintergrund: der CSP-Kommentar in src/app.js. pool.ejs (jobListe) und kreditkarte.ejs (kkListe)
  // bauen HTML-Strings, die per <%- ausgegeben werden. Daten (Titel, Namen …) dürfen dort nicht
  // hinein, sonst entgehen sie der Escaping-Pflicht von <%= %>.
  const erlaubt = [/^include\(/, /^klasse(Tabelle|Kacheln)$/, /^gewaehlteAnsicht === 'auto' \? '[^']*' : ''$/];
  const alle = [viewsDir, adminViewsDir].flatMap((dir) => readdirSync(dir).filter((f) => f.endsWith('.ejs')).map((f) => join(dir, f)));
  for (const datei of alle) {
    const inhalt = readFileSync(datei, 'utf8').replace(/<script\b[\s\S]*?<\/script>/g, '');
    for (const block of inhalt.match(/<%(?![-=#])[\s\S]*?%>/g) || []) {
      for (const literal of block.match(/`[^`]*<[^`]*`/g) || []) {
        for (const [, ausdruck] of literal.matchAll(/\$\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/g)) {
          assert.ok(erlaubt.some((re) => re.test(ausdruck.trim())), `${datei}: \${${ausdruck}} landet ungeschützt in <%- %>`);
        }
      }
    }
  }
});
