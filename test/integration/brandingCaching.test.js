// Rückmeldung 2026-10-26: Nach dem Speichern unter Admin → Module meldete die Konsole 429 für
// /branding/logo und /branding/logo-dunkel. Das Logo hängt an jeder Seite (bis zu zwei Bilder je
// Aufruf) und teilte sich den IP-Zähler des öffentlichen Missbrauchs-Limiters (100/15 min) mit
// /, /auth und /audit-pruefen — ohne Cache-Header wurde es zudem bei jedem Seitenaufruf neu geholt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/db/index.js';
import { setConfigValue } from '../../src/db/adminConfigRepo.js';
import { createApp } from '../../src/app.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

function testConfig() {
  return {
    sessionSecret: 'test-secret',
    env: 'test',
    churchtools: { baseUrl: 'https://ct.example.org', groupIdBuchhaltung: '10', groupIdAdmin: '20' },
  };
}

function mitLogo() {
  const dir = mkdtempSync(join(tmpdir(), 'freigabeportal-logo-'));
  const pfad = join(dir, 'logo.png');
  writeFileSync(pfad, PNG);
  const db = openDatabase(':memory:');
  setConfigValue(db, 'branding_logo_pfad', pfad);
  setConfigValue(db, 'branding_logo_mimetype', 'image/png');
  const app = createApp({ db, config: testConfig() });
  return { db, app, pfad, aufraeumen: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('/branding/logo wird nicht vom öffentlichen Missbrauchs-Limiter gedrosselt und verbraucht dessen Budget nicht', async () => {
  const { app, aufraeumen } = mitLogo();
  try {
    for (let i = 0; i < 120; i++) {
      const res = await request(app).get('/branding/logo');
      assert.equal(res.status, 200, `Logo-Abruf ${i} darf nicht gedrosselt werden`);
    }
    const start = await request(app).get('/');
    assert.notEqual(start.status, 429, 'Logo-Abrufe dürfen das Budget von / nicht aufbrauchen');
  } finally {
    aufraeumen();
  }
});

test('/branding/logo liefert ETag/Last-Modified und beantwortet If-None-Match mit 304', async () => {
  const { app, aufraeumen } = mitLogo();
  try {
    const res = await request(app).get('/branding/logo');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /^image\/png/);
    assert.ok(res.headers.etag, 'ETag fehlt');
    assert.ok(res.headers['last-modified'], 'Last-Modified fehlt');
    const erneut = await request(app).get('/branding/logo').set('If-None-Match', res.headers.etag);
    assert.equal(erneut.status, 304);
  } finally {
    aufraeumen();
  }
});

test('Seiten verlinken das Logo mit Versionsparameter; versionierte Abrufe sind lange cachebar', async () => {
  const { app, pfad, aufraeumen } = mitLogo();
  try {
    const seite = await request(app).get('/nonexistent-route-xyz');
    const m = /<img src="\/branding\/logo\?v=([a-z0-9]+)" alt="Logo"/.exec(seite.text);
    assert.ok(m, 'Logo-URL ohne ?v=');
    const res = await request(app).get(`/branding/logo?v=${m[1]}`);
    assert.equal(res.status, 200);
    assert.match(res.headers['cache-control'], /max-age=\d{4,}/);
    // Ohne Version: nur revalidieren (neues Logo nach dem Hochladen sofort sichtbar).
    const ohne = await request(app).get('/branding/logo');
    assert.match(ohne.headers['cache-control'], /no-cache/);
    // Neues Logo (andere Änderungszeit) → neue Version in der URL.
    const spaeter = new Date(Date.now() + 60_000);
    utimesSync(pfad, spaeter, spaeter);
    const neu = await request(app).get('/nonexistent-route-xyz');
    const m2 = /<img src="\/branding\/logo\?v=([a-z0-9]+)"/.exec(neu.text);
    assert.ok(m2);
    assert.notEqual(m2[1], m[1]);
  } finally {
    aufraeumen();
  }
});

// Live-Portal-Konsole: "/js/portal.js/" (mit Schrägstrich) → 404 als text/html, Skript verweigert.
// Im aktuellen Code verweist keine Seite so darauf (_seite_ende: absolutes /js/portal.js, keine
// <base>, keine Umleitung, die einen Schrägstrich anhängt); ein Schrägstrich, der von aussen
// (Proxy, Lesezeichen, alte Seite) angehängt wird, führt jetzt per 301 zur Datei statt zur HTML-404.
test('Statische Datei mit angehängtem Schrägstrich wird auf die Datei umgeleitet, nicht als HTML-404 beantwortet', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, config: testConfig() });
  try {
    const res = await request(app).get('/js/portal.js/');
    assert.equal(res.status, 301);
    assert.equal(res.headers.location, '/js/portal.js');
    const css = await request(app).get('/css/portal.css//?x=1');
    assert.equal(css.status, 301);
    assert.equal(css.headers.location, '/css/portal.css?x=1');
    // Unbekannte Datei bleibt 404 (kein Umleiten ins Leere).
    const fehlt = await request(app).get('/js/gibt-es-nicht.js/');
    assert.equal(fehlt.status, 404);
    // Seite mit Schrägstrich unverändert.
    const seite = await request(app).get('/js/portal.js');
    assert.equal(seite.status, 200);
    assert.match(seite.headers['content-type'], /javascript/);
  } finally {
    db.close();
  }
});
