// Ansichtswahl Tabelle/Kacheln auf /pool (Task 7) gegen die echte App, damit Middleware und Cookies laufen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupMockChurchTools } from '../helpers/mockChurchTools.js';
import { openDatabase } from '../../src/db/index.js';
import { createApp } from '../../src/app.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createKonto } from '../../src/db/kontenRepo.js';
import { createJob, claimJob, setThumbnailPfad, setKontierung, ablehnenJob, createSpesenPosition } from '../../src/db/jobsRepo.js';
import { createSpesenabrechnung } from '../../src/db/spesenabrechnungenRepo.js';
import { seedDefaults, setConfigValue } from '../../src/db/adminConfigRepo.js';
import { createKreditkarte } from '../../src/db/kreditkartenRepo.js';
import { createKkBeleg } from '../../src/db/kkBelegeRepo.js';
import { deactivatePerson } from '../../src/db/personenRepo.js';
import { setBerechtigungenForPerson } from '../../src/db/personBerechtigungenRepo.js';
import { divBereiche, ansichtPaare, doppelteIds, linkZiele } from '../helpers/ansichtParitaet.js';

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

// ---------- Task 8: übrige sechs Listen ----------

async function loginSuperadmin(db) {
  const config = testConfig();
  const client = setupMockChurchTools(config.churchtools.baseUrl);
  client.intercept({ path: '/oauth/access_token', method: 'POST' }).reply(200, { access_token: 'tok' });
  client
    .intercept({ path: '/oauth/userinfo', method: 'GET' })
    .reply(200, { id: 1, firstName: 'Buch', lastName: 'Halter', email: 'buch@example.org' });
  client.intercept({ path: '/api/groups/10/members', method: 'GET' }).reply(200, { data: [{ personId: 1 }] });
  client.intercept({ path: '/api/groups/20/members', method: 'GET' }).reply(200, { data: [{ personId: 1 }] });
  const app = createApp({ db, config });
  const agent = request.agent(app);
  const loginRes = await agent.get('/auth/login');
  const state = new URL(loginRes.headers.location).searchParams.get('state');
  await agent.get('/auth/callback').query({ code: 'the-code', state });
  return agent;
}

// Person 1 (angemeldet) ist Buchhaltung + Superadmin; 2/3 sind Konto-Personen, 4 ist inaktiv.
function seedAlles(db) {
  upsertPerson(db, { id: '1', vorname: 'Buch', nachname: 'Halter', email: 'buch@example.org', gruppen: ['10', '20'], loggedInNow: false });
  for (const id of ['2', '3', '4']) {
    upsertPerson(db, { id, vorname: `Person${id}`, nachname: 'Muster', email: `p${id}@example.org`, gruppen: [], loggedInNow: false });
  }
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '2', stellvertreter1Id: '3', freigeber2Id: '3', stellvertreter2Id: '2' });
  return kontoId;
}

function abgeschlossenerJob(db, kontoId, dateiname) {
  const id = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname, pdfPfad: `/tmp/${dateiname}` });
  setKontierung(db, id, kontoId);
  db.prepare("UPDATE jobs SET status = 'abgeschlossen', betrag = '99.90' WHERE id = ?").run(id);
  return id;
}

// Gemeinsame Prüfung: Kachelansicht ohne Tabelle, Kachel enthält Titel, Betrag und alle Ziele der Tabellenansicht.
async function pruefeKachelParitaet(agent, pfad, cookieName, { titel, betrag, kachelId }) {
  const auto = await agent.get(pfad);
  assert.equal(auto.status, 200);
  const [paar] = ansichtPaare(auto.text);
  assert.ok(paar.tabellenZiele.length > 0, 'Tabelle ohne Aktionsziele — Test-Seed prüfen');
  assert.deepEqual(paar.kachelZiele, paar.tabellenZiele);
  assert.deepEqual(doppelteIds(auto.text), []);
  assert.match(divBereiche(auto.text, 'seitenkopf-aktionen')[0], /ansicht-umschalter/);

  const res = await agent.get(pfad).set('Cookie', `${cookieName}=kacheln`);
  assert.equal(res.status, 200);
  assert.doesNotMatch(res.text, /<table/);
  assert.doesNotMatch(res.text, /ansicht-tabelle/);
  assert.match(res.text, /class="ansicht-kacheln"/);
  assert.match(res.text, kachelId);
  const kacheln = divBereiche(res.text, 'ansicht-kacheln')[0];
  assert.ok(kacheln.includes(titel), `Titel ${titel} fehlt`);
  if (betrag) assert.match(kacheln, new RegExp(`kachel-betrag">\\s*${betrag.replace('.', '\\.')}`));
  for (const ziel of paar.tabellenZiele) assert.ok(linkZiele(kacheln).includes(ziel), `${ziel} fehlt in der Kachel`);
  return res;
}

test('/meine-abgeschlossenen Kacheln: Dateiname, Status, Zeitstempel, Jetzt prüfen', async () => {
  const db = openDatabase(':memory:');
  const agent = await loginSuperadmin(db);
  const id = abgeschlossenerJob(db, seedAlles(db), 'fertig.pdf');
  db.prepare("UPDATE jobs SET eingereicht_von = NULL, zugewiesen_an = '1' WHERE id = ?").run(id);
  await pruefeKachelParitaet(agent, '/meine-abgeschlossenen', 'ansicht_meine-abgeschlossenen', {
    titel: 'fertig.pdf', kachelId: new RegExp(`id="abgeschlossen-kachel-${id}"`),
  });
  db.close();
});

test('/meine-spesen Kacheln: Verwendungszweck, Betrag, Status, Jetzt prüfen', async () => {
  const db = openDatabase(':memory:');
  const agent = await loginSuperadmin(db);
  const kontoId = seedAlles(db);
  const abrechnung = createSpesenabrechnung(db, { eingereichtVon: '1', eingereichtAm: '2026-08-31T08:00:00.000Z', titel: null });
  const id = createSpesenPosition(db, {
    eingangAm: '2026-08-31T08:00:00.000Z', eingereichtVon: '1', kontoId, betrag: '10.00', auslageDatum: '2026-08-20',
    beschreibung: 'Taxi zum Lager', dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf', thumbnailPfad: null, spesenabrechnungId: abrechnung,
    zugewiesenAn: '2', freigabe1EskaliertVon: null, freigabe1Eskalationsgrund: null,
  });
  db.prepare("UPDATE jobs SET status = 'abgeschlossen' WHERE id = ?").run(id);
  await pruefeKachelParitaet(agent, '/meine-spesen', 'ansicht_meine-spesen', {
    titel: 'Taxi zum Lager', betrag: '10.00', kachelId: new RegExp(`id="spesen-meine-kachel-${id}"`),
  });
  db.close();
});

test('/kreditkarte Kacheln: Beschreibung, Betrag, Beleg-Link und Bearbeiten', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  setConfigValue(db, 'modul_kreditkarten_aktiv', '1');
  const agent = await loginSuperadmin(db);
  seedAlles(db);
  const karte = createKreditkarte(db, { bezeichnung: 'Visa Offen', verantwortlichId: '1', erfassungOffen: true });
  const id = createKkBeleg(db, {
    kreditkarteId: karte, hochgeladenVon: '1', quelle: 'web', pdfPfad: '/tmp/b.pdf', thumbnailPfad: '/tmp/b.png',
    betrag: '12.50', kaufdatum: '2026-09-01', beschreibung: 'Zugticket Bern', status: 'offen',
  });
  const res = await pruefeKachelParitaet(agent, '/kreditkarte', 'ansicht_kreditkarte', {
    titel: 'Zugticket Bern', betrag: '12.50', kachelId: new RegExp(`id="kk-offen-kachel-${id}"`),
  });
  const kachel = divBereiche(res.text, 'ansicht-kacheln')[0];
  assert.ok(kachel.indexOf('<img') < kachel.indexOf('Zugticket Bern'), 'Vorschaubild gehört an den Kachelanfang');
  assert.match(kachel, /\/kreditkarte\/belege\/\d+\/bearbeiten/);
  db.close();
});

test('/admin/vorgaenge Kacheln: hängender Vorgang mit Rand und Badge, Umhängen, Filter bleibt über beiden Ansichten', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  const agent = await loginSuperadmin(db);
  const kontoId = seedAlles(db);
  deactivatePerson(db, '4');
  const id = createJob(db, { eingangAm: '2026-10-01T08:00:00.000Z', quelle: 'lieferant', absender: 'x@firma.ch', dateiname: 'haengt.pdf', pdfPfad: '/tmp/h.pdf' });
  db.prepare("UPDATE jobs SET status = 'zugewiesen', zugewiesen_an = '4', konto_id = ?, lieferant = 'Hänger AG', betrag = '250.00' WHERE id = ?").run(kontoId, id);
  const res = await pruefeKachelParitaet(agent, '/admin/vorgaenge', 'ansicht_admin-vorgaenge', {
    titel: 'Hänger AG', betrag: '250.00', kachelId: new RegExp(`id="vorgang-kachel-${id}"`),
  });
  const kachel = divBereiche(res.text, 'ansicht-kacheln')[0];
  assert.match(kachel, /kachel-haengt/);
  assert.match(kachel, /badge text-bg-danger ms-1">hängt</);
  assert.match(kachel, />Umhängen</);
  assert.match(res.text, /<form[^>]*class="filterzeile"/);
  assert.doesNotMatch(divBereiche(res.text, 'ansicht-kacheln')[0], /filterzeile/);
  // Tabellenansicht behält die Zeilenfärbung.
  const tab = await agent.get('/admin/vorgaenge').set('Cookie', 'ansicht_admin-vorgaenge=tabelle');
  assert.match(tab.text, /class="table-danger"/);
  assert.doesNotMatch(tab.text, /kachel-haengt/);
  db.close();
});

test('/admin/vorgaenge?ansicht=kacheln&status=… leitet um und behält status', async () => {
  const db = openDatabase(':memory:');
  const agent = await loginSuperadmin(db);
  const res = await agent.get('/admin/vorgaenge?ansicht=kacheln&status=zugewiesen');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/admin/vorgaenge?status=zugewiesen');
  assert.match(res.headers['set-cookie'].join(';'), /ansicht_admin-vorgaenge=kacheln/);
  db.close();
});

test('/admin/abgelehnt Kacheln: Lieferant als Titel, Grund, Löschen', async () => {
  const db = openDatabase(':memory:');
  const agent = await loginSuperadmin(db);
  const kontoId = seedAlles(db);
  const id = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'schlecht.pdf', pdfPfad: '/tmp/s.pdf' });
  claimJob(db, id, '2');
  setKontierung(db, id, kontoId);
  db.prepare("UPDATE jobs SET lieferant = 'Schlecht GmbH' WHERE id = ?").run(id);
  ablehnenJob(db, id, { abgelehntVon: '2', grund: 'Falscher Empfänger' });
  const res = await pruefeKachelParitaet(agent, '/admin/abgelehnt', 'ansicht_admin-abgelehnt', {
    titel: 'Schlecht GmbH', kachelId: new RegExp(`id="abgelehnt-kachel-${id}"`),
  });
  assert.match(res.text, /Falscher Empfänger/);
  db.close();
});

test('/admin/altfaelle Kacheln: Dateiname, Grund, Prüfen', async () => {
  const db = openDatabase(':memory:');
  const agent = await loginSuperadmin(db);
  const id = abgeschlossenerJob(db, seedAlles(db), 'alt.pdf');
  await pruefeKachelParitaet(agent, '/admin/altfaelle', 'ansicht_admin-altfaelle', {
    titel: 'alt.pdf', kachelId: new RegExp(`id="altfall-kachel-${id}"`),
  });
  db.close();
});

test('/pool zeigt den Eingang lesbar in Ortszeit, in Tabelle und Kacheln', async () => {
  const db = openDatabase(':memory:');
  const agent = await loginBuchhaltung(db);
  seed(db);
  const res = await agent.get('/pool');
  assert.equal(res.status, 200);
  const tabelle = divBereiche(res.text, 'ansicht-tabelle').join('');
  const kacheln = divBereiche(res.text, 'ansicht-kacheln').join('');
  for (const teil of [tabelle, kacheln]) {
    assert.match(teil, /15\.08\.2026 10:00/);
    assert.doesNotMatch(teil, /2026-08-15T08:00:00\.000Z/);
  }
  db.close();
});
