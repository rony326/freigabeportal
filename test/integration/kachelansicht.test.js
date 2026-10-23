// Ansichtswahl Tabelle/Kacheln auf /pool (Task 7) gegen die echte App, damit Middleware und Cookies laufen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupMockChurchTools } from '../helpers/mockChurchTools.js';
import { openDatabase } from '../../src/db/index.js';
import { createApp } from '../../src/app.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createKonto } from '../../src/db/kontenRepo.js';
import { createJob, claimJob, setThumbnailPfad } from '../../src/db/jobsRepo.js';
import { setBerechtigungenForPerson } from '../../src/db/personBerechtigungenRepo.js';
import { divBereiche, ansichtPaare, doppelteIds } from '../helpers/ansichtParitaet.js';

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
    jobsDir: '/tmp/freigabeportal-kachel-test-jobs',
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

// 2 Pool-Jobs (einer mit Vorschaubild) + 1 eigene offene Kontierung.
function seed(db) {
  for (const id of ['2', '3']) {
    upsertPerson(db, { id, vorname: `Person${id}`, nachname: 'Muster', email: `p${id}@example.org`, gruppen: [], loggedInNow: false });
  }
  upsertPerson(db, { id: '1', vorname: 'Buch', nachname: 'Halter', email: 'buch@example.org', gruppen: ['10'], loggedInNow: false });
  createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '2', stellvertreter1Id: '3', freigeber2Id: '3', stellvertreter2Id: '2' });
  const poolA = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  const poolB = createJob(db, { eingangAm: '2026-08-16T08:00:00.000Z', quelle: 'lieferant', absender: 'rechnung@firma.ch', dateiname: 'b.pdf', pdfPfad: '/tmp/b.pdf' });
  setThumbnailPfad(db, poolA, '/tmp/a.png');
  const eigen = createJob(db, { eingangAm: '2026-08-17T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'c.pdf', pdfPfad: '/tmp/c.pdf' });
  claimJob(db, eigen, '1');
  return { poolA, poolB, eigen };
}

test('/pool ohne Cookie: Tabelle und Kacheln responsiv, alle IDs eindeutig, Umschalter im Seitenkopf', async () => {
  const db = openDatabase(':memory:');
  const agent = await loginBuchhaltung(db);
  const { poolA, poolB } = seed(db);
  setBerechtigungenForPerson(db, '1', ['pool_zuweisen']);
  const res = await agent.get('/pool');
  assert.equal(res.status, 200);
  assert.match(res.text, /class="ansicht-tabelle d-none d-lg-block"/);
  assert.match(res.text, /class="ansicht-kacheln d-lg-none"/);
  assert.deepEqual(doppelteIds(res.text), []);
  assert.match(res.text, /id="pool-kachel-\d+"/);
  assert.match(res.text, /id="pool-row-\d+"/);
  const kopf = divBereiche(res.text, 'seitenkopf-aktionen')[0];
  assert.match(kopf, /ansicht-umschalter/);
  // Vorschaubild in der Kachel mit denselben Daten wie in der Tabelle; ohne Thumbnail „Keine Vorschau“.
  const [poolPaar] = ansichtPaare(res.text);
  const bild = poolPaar.tabelle.match(new RegExp(`<img[^>]*data-job-id="${poolA}"[^>]*>`))[0];
  const kachelBild = poolPaar.kacheln.match(new RegExp(`<img[^>]*data-job-id="${poolA}"[^>]*>`));
  assert.ok(kachelBild, 'Vorschaubild fehlt in der Kachel');
  assert.match(kachelBild[0], /class="[^"]*thumbnail-preview[^"]*pdf-preview/);
  assert.equal(kachelBild[0].match(/data-preview-url="([^"]*)"/)[1], bild.match(/data-preview-url="([^"]*)"/)[1]);
  const kachelB = poolPaar.kacheln.match(new RegExp(`id="pool-kachel-${poolB}"[\\s\\S]*?beanspruchen-btn`))[0];
  assert.match(kachelB, /Keine Vorschau/);
  assert.match(kachelB, /Lieferant/);
  assert.match(kachelB, /rechnung@firma\.ch/);
  db.close();
});

test('/pool mit Cookie ansicht_pool=kacheln: keine Tabelle, Kacheln mit Beanspruchen und Zuweisen', async () => {
  const db = openDatabase(':memory:');
  const agent = await loginBuchhaltung(db);
  const { poolA, poolB } = seed(db);
  setBerechtigungenForPerson(db, '1', ['pool_zuweisen']);
  const res = await agent.get('/pool').set('Cookie', 'ansicht_pool=kacheln');
  assert.equal(res.status, 200);
  assert.doesNotMatch(res.text, /<table/);
  assert.doesNotMatch(res.text, /ansicht-tabelle/);
  assert.match(res.text, /class="ansicht-kacheln"/);
  assert.match(res.text, /row row-cols-1 row-cols-sm-2 row-cols-lg-3 row-cols-xl-4 g-3/);
  for (const id of [poolA, poolB]) {
    const kachel = res.text.match(new RegExp(`<div[^>]*id="pool-kachel-${id}"[\\s\\S]*?</form>`));
    assert.ok(kachel, `Kachel ${id} fehlt`);
    assert.match(kachel[0], /data-job-container/);
    assert.match(kachel[0], new RegExp(`class="beanspruchen-btn[^"]*" data-job-id="${id}"`));
    assert.match(kachel[0], new RegExp(`class="zuweisen-form[^"]*" data-job-id="${id}"`));
    assert.match(kachel[0], /<select[^>]*name="personId"/);
  }
  assert.deepEqual(doppelteIds(res.text), []);
  db.close();
});

test('/pool mit Cookie ansicht_pool=tabelle: keine Kacheln', async () => {
  const db = openDatabase(':memory:');
  const agent = await loginBuchhaltung(db);
  seed(db);
  const res = await agent.get('/pool').set('Cookie', 'ansicht_pool=tabelle');
  assert.equal(res.status, 200);
  assert.doesNotMatch(res.text, /ansicht-kacheln/);
  assert.match(res.text, /class="ansicht-tabelle"/);
  assert.match(res.text, /<table/);
  assert.match(res.text, /data-job-container/);
  db.close();
});

test('/pool Parität: Tabelle und Kacheln haben dieselben href-/action-Ziele (inkl. „In den Pool legen“ mit _csrf)', async () => {
  const db = openDatabase(':memory:');
  const agent = await loginBuchhaltung(db);
  const { eigen } = seed(db);
  const res = await agent.get('/pool');
  assert.equal(res.status, 200);
  const paare = ansichtPaare(res.text);
  assert.ok(paare.length >= 2, 'Pool und Meine offenen Kontierungen erwartet');
  for (const paar of paare) assert.deepEqual(paar.kachelZiele, paar.tabellenZiele);
  const kontierung = paare.find((p) => p.tabellenZiele.includes(`href:/kontierung/${eigen}`));
  assert.ok(kontierung, 'Abschnitt mit linkPrefix /kontierung fehlt');
  assert.ok(kontierung.kachelZiele.includes(`action:/kontierung/${eigen}/zurueck-in-pool`));
  const form = kontierung.kacheln.match(/<form[^>]*zurueck-in-pool[\s\S]*?<\/form>/)[0];
  assert.match(form, /name="_csrf" value="[^"]+"/);
  assert.match(form, /In den Pool legen/);
  assert.match(kontierung.kacheln, new RegExp(`id="kontierung-kachel-${eigen}"`));
  db.close();
});
