import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createKonto } from '../../src/db/kontenRepo.js';
import { createJob } from '../../src/db/jobsRepo.js';
import { createFreigabe } from '../../src/db/freigabenRepo.js';
import { createKreditkarte } from '../../src/db/kreditkartenRepo.js';
import { createKkBeleg } from '../../src/db/kkBelegeRepo.js';
import { seedDefaults, setConfigValue } from '../../src/db/adminConfigRepo.js';
import { createApp } from '../../src/app.js';
import { buildSignedDownloadUrl } from '../../src/services/downloadUrl.js';
import { setupMockChurchTools } from '../helpers/mockChurchTools.js';

// Task 3 / Zugriff: ein Durchgang, der für jede Route, die Job-/Datei-/Kommentar-/KK-Daten
// zurückgibt, die fremde Ressource als unbeteiligte Person (IDOR) anfragt und 403/404 ohne
// Datenabfluss erwartet — plus positive Gegenproben, dass die berechtigte Person 200 bekommt.
// GRUP_BH = '10' (Buchhaltung), GRUP_ADMIN = '20' (Superadmin).

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
      syncServiceToken: 'token',
    },
    cronSecret: 'cron-secret',
    smtp: { host: 'smtp.example.org', port: 587, user: 'user', pass: 'pass', from: 'portal@example.org' },
    publicBaseUrl: 'http://portal.example.org',
    downloadSigningSecret: 'download-secret',
  };
}

async function loginAs(app, client, { id, gruppen }) {
  client.intercept({ path: '/oauth/access_token', method: 'POST' }).reply(200, { access_token: `tok-${id}` });
  client.intercept({ path: '/oauth/userinfo', method: 'GET' }).reply(200, { id, firstName: `V${id}`, lastName: `N${id}`, email: `p${id}@example.org` });
  client.intercept({ path: '/api/groups/10/members', method: 'GET' }).reply(200, { data: gruppen.includes('10') ? [{ personId: id }] : [] });
  client.intercept({ path: '/api/groups/20/members', method: 'GET' }).reply(200, { data: gruppen.includes('20') ? [{ personId: id }] : [] });
  const agent = request.agent(app);
  const loginRes = await agent.get('/auth/login');
  const state = new URL(loginRes.headers.location).searchParams.get('state');
  const cb = await agent.get('/auth/callback').query({ code: `code-${id}`, state });
  assert.equal(cb.status, 302, `login ${id}`);
  return agent;
}

// Eindeutige, leicht auffindbare Dateinamen: taucht einer davon in einer Verweigerungsantwort auf,
// ist Inhalt abgeflossen.
const GEHEIM = {
  kontierung: 'GEHEIM-kontierung-xyz.pdf',
  freigabe2: 'GEHEIM-freigabe2-xyz.pdf',
  abgelehnt: 'GEHEIM-abgelehnt-xyz.pdf',
  spesen: 'GEHEIM-spesen-xyz.pdf',
};

async function baueUmgebung() {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  setConfigValue(db, 'modul_kreditkarten_aktiv', '1');
  const config = testConfig();
  const app = createApp({ db, config });
  const client = setupMockChurchTools(config.churchtools.baseUrl);

  // owner: betroffene Freigeberin; stranger: unbeteiligt (auch Buchhaltung, um zu zeigen, dass die
  // Rolle allein keinen Zugriff auf fremde Vorgänge gibt); f2 effektive Freigabe-2-Person; admin.
  upsertPerson(db, { id: 'owner', vorname: 'Olivia', nachname: 'Owner', email: 'owner@example.org', gruppen: ['10'] });
  upsertPerson(db, { id: 'stranger', vorname: 'Stefan', nachname: 'Stranger', email: 'stranger@example.org', gruppen: ['10'] });
  upsertPerson(db, { id: 'f2', vorname: 'Franka', nachname: 'Zwei', email: 'f2@example.org', gruppen: ['10'] });
  upsertPerson(db, { id: 'einreicher', vorname: 'Erich', nachname: 'Einreicher', email: 'e@example.org', gruppen: ['10'] });
  upsertPerson(db, { id: 'admin', vorname: 'Adele', nachname: 'Admin', email: 'admin@example.org', gruppen: ['20'] });

  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: 'owner', stellvertreter1Id: 'einreicher', freigeber2Id: 'f2', stellvertreter2Id: 'einreicher' });

  const neuerJob = (dateiname, patch) => {
    const id = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname, pdfPfad: `/tmp/${dateiname}`, dateiHash: `hash-${dateiname}` });
    const sets = Object.keys(patch).map((k) => `${k} = ?`).join(', ');
    db.prepare(`UPDATE jobs SET ${sets} WHERE id = ?`).run(...Object.values(patch), id);
    return id;
  };

  const ids = {};
  ids.kontierung = neuerJob(GEHEIM.kontierung, { status: 'zugewiesen', zugewiesen_an: 'owner', konto_id: kontoId });
  ids.freigabe2 = neuerJob(GEHEIM.freigabe2, { status: 'freigabe2', zugewiesen_an: 'owner', konto_id: kontoId });
  ids.abgelehnt = neuerJob(GEHEIM.abgelehnt, { status: 'abgelehnt', zugewiesen_an: 'owner', konto_id: kontoId, abgelehnt_von: 'f2' });
  ids.spesen = neuerJob(GEHEIM.spesen, { status: 'zugewiesen', zugewiesen_an: 'owner', konto_id: kontoId, quelle: 'spesen', eingereicht_von: 'einreicher' });
  // Freigabe-1-Nachweis, damit die /freigabe2-Seite für f2 (Gegenprobe) rendern kann.
  createFreigabe(db, { jobId: ids.freigabe2, personId: 'owner', rolle: 'freigeber1', zeitpunkt: '2026-08-15T09:00:00.000Z', ip: '::1', interessenskonflikt: false, kommentar: null, eskaliertVon: null });

  // KK-Beleg, der nur owner gehört.
  const karteId = createKreditkarte(db, { bezeichnung: 'Visa', karteEndziffern: '4242', karteninhaberName: 'Olivia', verantwortlichId: 'owner', erfassungOffen: false });
  ids.kkBeleg = createKkBeleg(db, { kreditkarteId: karteId, hochgeladenVon: 'owner', gekauftVon: 'owner', quelle: 'web', pdfPfad: '/tmp/kkbeleg.pdf', thumbnailPfad: '/tmp/kkbeleg.png', betrag: '12.50', kaufdatum: '2026-08-10', beschreibung: 'Ticket', kontoId, status: 'offen' });

  return { db, config, app, client, ids, kontoId };
}

test('IDOR-Sweep: unbeteiligte Person (selbst mit Buchhaltungsrolle) erreicht fremde Vorgänge/Dateien/Kommentare/KK nicht', async () => {
  const u = await baueUmgebung();
  const stranger = await loginAs(u.app, u.client, { id: 'stranger', gruppen: ['10'] });

  const geheimWerte = Object.values(GEHEIM);
  const keinLeck = (res) => {
    for (const name of geheimWerte) assert.ok(!res.text?.includes(name), `Datenabfluss: ${name} in Antwort (${res.req?.path})`);
  };

  // Arbeits- und Detailseiten eines fremden Vorgangs.
  const seiten = [
    ['get', `/kontierung/${u.ids.kontierung}`, 403],
    ['get', `/kontierung/${u.ids.kontierung}/aufsplitten`, 403],
    ['get', `/kontierung/${u.ids.freigabe2}/kk-abgleich`, 403],
    ['get', `/freigabe2/${u.ids.freigabe2}`, 403],
    ['get', `/abgelehnt/${u.ids.abgelehnt}`, 403],
    ['get', `/spesen-freigabe1/${u.ids.spesen}`, 403],
  ];
  for (const [methode, pfad, status] of seiten) {
    const res = await stranger[methode](pfad);
    assert.equal(res.status, status, `${methode.toUpperCase()} ${pfad}`);
    keinLeck(res);
  }

  // Datei-/Vorschau-Endpunkte eines fremden Jobs.
  const dateiEndpunkte = [
    [`/downloads/${u.ids.kontierung}/refresh-url`, 403],
    [`/downloads/${u.ids.kontierung}/oeffnen`, 403],
    [`/downloads/${u.ids.kontierung}/thumbnail`, 404],
    [`/zeitstempel-pruefen?jobId=${u.ids.kontierung}`, 403],
    [`/zeitstempel-pruefen/zertifikat?jobId=${u.ids.kontierung}`, 403],
    [`/kreditkarte/belege/${u.ids.kkBeleg}/datei`, 404],
    [`/kreditkarte/belege/${u.ids.kkBeleg}/thumbnail`, 404],
    [`/admin/vorgaenge/${u.ids.kontierung}`, 403],
  ];
  for (const [pfad, status] of dateiEndpunkte) {
    const res = await stranger.get(pfad);
    assert.equal(res.status, status, `GET ${pfad}`);
    keinLeck(res);
  }

  // Kommentar-POST an einen fremden Vorgang: 403, kein Kommentar entsteht.
  const vorher = u.db.prepare('SELECT COUNT(*) c FROM kommentare').get().c;
  const token = (await stranger.get('/pool')).text.match(/name="_csrf" value="([^"]+)"/)[1];
  const komm = await stranger.post(`/kommentare/${u.ids.kontierung}`).type('form').send({ text: 'Einschleichversuch', zurueck: '', _csrf: token });
  assert.equal(komm.status, 403, 'POST /kommentare fremder Job');
  assert.equal(u.db.prepare('SELECT COUNT(*) c FROM kommentare').get().c, vorher, 'kein Kommentar angelegt');

  u.db.close();
});

test('IDOR-Sweep: eine signierte Download-URL gilt nur für ihren Job und nicht mit gefälschter Signatur', async () => {
  const u = await baueUmgebung();
  // Gültige Signatur für kontierung-Job (öffentlicher Stream, nur Signatur zählt).
  const gueltig = buildSignedDownloadUrl(u.config, u.ids.kontierung, 300);
  // Dieselbe Signatur auf einen anderen Job umbiegen -> 403 (HMAC bindet die Job-ID).
  const umgebogen = gueltig.replace(`/downloads/${u.ids.kontierung}?`, `/downloads/${u.ids.freigabe2}?`);
  const gefaelscht = gueltig.replace(/signature=[0-9a-f]+/, 'signature=' + 'd'.repeat(64));
  assert.equal((await request(u.app).get(umgebogen)).status, 403, 'Signatur auf fremden Job umgebogen');
  assert.equal((await request(u.app).get(gefaelscht)).status, 403, 'gefälschte Signatur');
  assert.equal((await request(u.app).get(`/downloads/${u.ids.kontierung}?expires=9999999999&signature=abc`)).status, 403, 'frei erfundene Signatur');
  u.db.close();
});

test('IDOR-Sweep: ohne Anmeldung liefern die geschützten Endpunkte 401/302, nie Inhalt', async () => {
  const u = await baueUmgebung();
  const anon = request(u.app);
  for (const pfad of [
    `/kontierung/${u.ids.kontierung}`,
    `/freigabe2/${u.ids.freigabe2}`,
    `/downloads/${u.ids.kontierung}/refresh-url`,
    `/downloads/${u.ids.kontierung}/thumbnail`,
    `/zeitstempel-pruefen?jobId=${u.ids.kontierung}`,
    `/kreditkarte/belege/${u.ids.kkBeleg}/datei`,
  ]) {
    const res = await anon.get(pfad);
    assert.ok([401, 302].includes(res.status), `GET ${pfad} -> ${res.status}`);
    for (const name of Object.values(GEHEIM)) assert.ok(!res.text?.includes(name), `Leck ${name} ohne Login`);
  }
  // /admin ohne Login -> 401.
  assert.equal((await anon.get(`/admin/vorgaenge/${u.ids.kontierung}`)).status, 401);
  u.db.close();
});

test('Gegenprobe: die jeweils zuständige Person (und Superadmin) bekommt ihren Vorgang zu sehen', async () => {
  const u = await baueUmgebung();
  const owner = await loginAs(u.app, u.client, { id: 'owner', gruppen: ['10'] });
  const f2 = await loginAs(u.app, u.client, { id: 'f2', gruppen: ['10'] });
  const admin = await loginAs(u.app, u.client, { id: 'admin', gruppen: ['20'] });

  assert.equal((await owner.get(`/kontierung/${u.ids.kontierung}`)).status, 200, 'owner sieht Kontierung');
  const refresh = await owner.get(`/downloads/${u.ids.kontierung}/refresh-url`);
  assert.equal(refresh.status, 200, 'owner bekommt Vorschau-URL');
  assert.match(refresh.body.url, /^\/downloads\//);
  assert.equal((await f2.get(`/freigabe2/${u.ids.freigabe2}`)).status, 200, 'f2 sieht Freigabe 2');
  assert.equal((await admin.get(`/admin/vorgaenge/${u.ids.kontierung}`)).status, 200, 'Superadmin sieht Vorgangsdetail');
  u.db.close();
});
