import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { openDatabase } from '../../../src/db/index.js';
import { upsertPerson } from '../../../src/db/personenRepo.js';
import { createKonto } from '../../../src/db/kontenRepo.js';
import { kreditorOhneIbanPflicht, kreditorMitIban } from '../../helpers/kreditor.js';
import { createKreditor, getKreditorById } from '../../../src/db/kreditorenRepo.js';
import { createZuweisungsregel, getZuweisungsregelById } from '../../../src/db/zuweisungsregelnRepo.js';
import { loadCurrentPerson } from '../../../src/middleware/roles.js';
import { loadNavFlags } from '../../../src/middleware/nav.js';
import { requirePermission } from '../../../src/middleware/permissions.js';
import { setBerechtigungenForPerson } from '../../../src/db/personBerechtigungenRepo.js';
import { createKreditorenRouter } from '../../../src/routes/admin/kreditoren.js';

function buildTestApp(db) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', new URL('../../../views', import.meta.url).pathname);
  app.use((req, res, next) => {
    res.locals.branding = { primaryColor: '#000', secondaryColor: '#fff', hasLogo: false, themeAttr: null };
    next();
  });
  app.use(express.urlencoded({ extended: false }));
  app.use((req, res, next) => {
    req.session = { personId: req.headers['x-test-person-id'] };
    next();
  });
  const config = { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20', groupIdManager: '30' } };
  app.use(loadCurrentPerson(db));
  app.use(loadNavFlags(db, config));
  app.use('/admin/kreditoren', requirePermission(db, config, 'kreditoren_verwalten'), createKreditorenRouter({ db }));
  return app;
}

function seedAdmin(db) {
  upsertPerson(db, { id: '99', vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'], loggedInNow: true });
}

function seedKonto(db) {
  for (const id of ['1', '2', '3', '4']) {
    upsertPerson(db, { id, vorname: `Person${id}`, nachname: 'Muster', email: `p${id}@example.org`, gruppen: ['10'], loggedInNow: false });
  }
  return createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
}

test('every /admin/kreditoren route returns 401 without a session', async () => {
  const db = openDatabase(':memory:');
  const app = buildTestApp(db);
  for (const res of [
    await request(app).get('/admin/kreditoren'),
    await request(app).post('/admin/kreditoren'),
    await request(app).get('/admin/kreditoren/1/bearbeiten'),
    await request(app).post('/admin/kreditoren/1'),
    await request(app).post('/admin/kreditoren/1/deaktivieren'),
    await request(app).post('/admin/kreditoren/1/aktivieren'),
    await request(app).post('/admin/kreditoren/regeln'),
    await request(app).get('/admin/kreditoren/regeln/1/bearbeiten'),
    await request(app).post('/admin/kreditoren/regeln/1'),
    await request(app).post('/admin/kreditoren/regeln/1/loeschen'),
  ]) {
    assert.equal(res.status, 401);
  }
  db.close();
});

test('every /admin/kreditoren route returns 403 for a non-admin (buchhaltung only)', async () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '77', vorname: 'Nur', nachname: 'Buchhaltung', email: 'b@example.org', gruppen: ['10'], loggedInNow: true });
  const app = buildTestApp(db);
  const res = await request(app).get('/admin/kreditoren').set('x-test-person-id', '77');
  assert.equal(res.status, 403);
  db.close();
});

test('POST /admin/kreditoren creates a Kreditor with an optional Standard-Konto', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  const kontoId = seedKonto(db);
  const app = buildTestApp(db);

  const res = await request(app)
    .post('/admin/kreditoren')
    .set('x-test-person-id', '99')
    .type('form')
    .send({ name: 'Muster AG', kontoId: String(kontoId), zahlungsart: 'lastschrift' });

  assert.equal(res.status, 302);
  const kreditorId = db.prepare("SELECT id FROM kreditoren WHERE name = 'Muster AG'").get().id;
  assert.equal(res.headers.location, `/admin/kreditoren/${kreditorId}/bearbeiten?gespeichert=1`);
  db.close();
});

test('POST /admin/kreditoren without a name is rejected', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  const app = buildTestApp(db);
  const res = await request(app).post('/admin/kreditoren').set('x-test-person-id', '99').type('form').send({ name: '' });
  assert.equal(res.status, 400);
  assert.match(res.text, /Name ist ein Pflichtfeld/);
  db.close();
});

test('Anlegen liegt auf einer eigenen Seite: Liste hat nur den Knopf, /neu das Formular, Fehler bleiben dort', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  seedKonto(db);
  const app = buildTestApp(db);

  const liste = await request(app).get('/admin/kreditoren').set('x-test-person-id', '99');
  assert.match(liste.text, /href="\/admin\/kreditoren\/neu"[^>]*>Neuer Kreditor</);
  assert.doesNotMatch(liste.text, /id="kreditorName"/, 'kein Anlege-Formular mehr unter der Liste');
  assert.doesNotMatch(liste.text, /Kreditor anlegen/);

  const neu = await request(app).get('/admin/kreditoren/neu').set('x-test-person-id', '99');
  assert.equal(neu.status, 200);
  assert.match(neu.text, /<h1[^>]*>Neuer Kreditor<\/h1>/);
  assert.match(neu.text, /<form method="post" action="\/admin\/kreditoren"/);
  assert.match(neu.text, /name="iban"/);
  assert.match(neu.text, /value="ueberweisung" checked/);
  assert.match(neu.text, /Kreditor anlegen/);

  // Fehler: gleiche Seite, Eingaben bleiben stehen.
  const fehler = await request(app).post('/admin/kreditoren').set('x-test-person-id', '99').type('form')
    .send({ name: 'Muster AG', zahlungsart: 'ueberweisung' });
  assert.equal(fehler.status, 400);
  assert.match(fehler.text, /<h1[^>]*>Neuer Kreditor<\/h1>/);
  assert.match(fehler.text, /value="Muster AG"/);
  db.close();
});

test('/admin/kreditoren/neu verlangt wie die Liste das Recht kreditoren_verwalten', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  const app = buildTestApp(db);
  const ohne = await request(app).get('/admin/kreditoren/neu');
  assert.ok([401, 403].includes(ohne.status), `ohne Anmeldung ${ohne.status}`);
  db.close();
});

test('GET /admin/kreditoren lists Kreditoren with their Standard-Konto resolved', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  const kontoId = seedKonto(db);
  createKreditor(db, { name: 'Muster AG', kontoId });
  const app = buildTestApp(db);

  const res = await request(app).get('/admin/kreditoren').set('x-test-person-id', '99');
  assert.equal(res.status, 200);
  assert.match(res.text, /Muster AG/);
  assert.match(res.text, /3000 — Unterhalt/);
  db.close();
});

test('POST /admin/kreditoren/:id updates a Kreditor, POST .../deaktivieren deactivates it', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  const kreditorId = kreditorOhneIbanPflicht(db, { name: 'Alt AG' });
  const app = buildTestApp(db);

  const updateRes = await request(app)
    .post(`/admin/kreditoren/${kreditorId}`)
    .set('x-test-person-id', '99')
    .type('form')
    .send({ name: 'Neu AG', kontoId: '' });
  assert.equal(updateRes.status, 302);
  assert.equal(getKreditorById(db, kreditorId).name, 'Neu AG');

  const deactivateRes = await request(app).post(`/admin/kreditoren/${kreditorId}/deaktivieren`).set('x-test-person-id', '99');
  assert.equal(deactivateRes.status, 302);
  assert.equal(getKreditorById(db, kreditorId).aktiv, 0);

  const listAfterDeactivate = await request(app).get('/admin/kreditoren').set('x-test-person-id', '99');
  assert.match(listAfterDeactivate.text, new RegExp(`/admin/kreditoren/${kreditorId}/aktivieren`), 'a Reaktivieren form should be rendered for the inactive Kreditor');
  assert.doesNotMatch(listAfterDeactivate.text, new RegExp(`/admin/kreditoren/${kreditorId}/deaktivieren`), 'no Deaktivieren form should be rendered for the inactive Kreditor');

  const reactivateRes = await request(app).post(`/admin/kreditoren/${kreditorId}/aktivieren`).set('x-test-person-id', '99');
  assert.equal(reactivateRes.status, 302);
  assert.equal(getKreditorById(db, kreditorId).aktiv, 1);
  db.close();
});

test('POST /admin/kreditoren/regeln creates a Zuweisungsregel mapping an Absender to a Kreditor', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  const kreditorId = createKreditor(db, { name: 'Muster AG', kontoId: null });
  const app = buildTestApp(db);

  const res = await request(app)
    .post('/admin/kreditoren/regeln')
    .set('x-test-person-id', '99')
    .type('form')
    .send({ absenderMuster: 'lieferant.ch', kreditorId: String(kreditorId) });

  assert.equal(res.status, 302);
  assert.equal(res.headers.location, `/admin/kreditoren/${kreditorId}/bearbeiten?gespeichert=1`);
  db.close();
});

test('POST /admin/kreditoren/regeln rejects a duplicate Absender-Muster', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  const kreditorId = createKreditor(db, { name: 'Muster AG', kontoId: null });
  createZuweisungsregel(db, { absenderMuster: 'lieferant.ch', kreditorId });
  const app = buildTestApp(db);

  const res = await request(app)
    .post('/admin/kreditoren/regeln')
    .set('x-test-person-id', '99')
    .type('form')
    .send({ absenderMuster: 'lieferant.ch', kreditorId: String(kreditorId) });

  assert.equal(res.status, 400);
  assert.match(res.text, /bereits einem Kreditor zugewiesen/);
  db.close();
});

test('Kreditor-Seite listet die Zuweisungsregeln des Kreditors', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  const kreditorId = createKreditor(db, { name: 'Muster AG', kontoId: null });
  createZuweisungsregel(db, { absenderMuster: 'lieferant.ch', kreditorId });
  const app = buildTestApp(db);

  const res = await request(app).get(`/admin/kreditoren/${kreditorId}/bearbeiten`).set('x-test-person-id', '99');
  assert.equal(res.status, 200);
  assert.match(res.text, /lieferant\.ch/);
  assert.match(res.text, /Muster AG/);
  db.close();
});

test('POST /admin/kreditoren/regeln/:id updates a rule, POST .../loeschen removes it', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  const kreditorId = createKreditor(db, { name: 'Muster AG', kontoId: null });
  const regelId = createZuweisungsregel(db, { absenderMuster: 'alt.ch', kreditorId });
  const app = buildTestApp(db);

  const updateRes = await request(app)
    .post(`/admin/kreditoren/regeln/${regelId}`)
    .set('x-test-person-id', '99')
    .type('form')
    .send({ absenderMuster: 'neu.ch', kreditorId: String(kreditorId) });
  assert.equal(updateRes.status, 302);
  assert.equal(getZuweisungsregelById(db, regelId).absender_muster, 'neu.ch');

  const deleteRes = await request(app).post(`/admin/kreditoren/regeln/${regelId}/loeschen`).set('x-test-person-id', '99');
  assert.equal(deleteRes.status, 302);
  assert.equal(getZuweisungsregelById(db, regelId), null);
  db.close();
});

test('every /admin/kreditoren/ibans route returns 401 without a session', async () => {
  const db = openDatabase(':memory:');
  const app = buildTestApp(db);
  for (const res of [
    await request(app).post('/admin/kreditoren/ibans'),
    await request(app).post('/admin/kreditoren/ibans/1/loeschen'),
  ]) {
    assert.equal(res.status, 401);
  }
  db.close();
});

test('POST /admin/kreditoren/ibans creates a mapping with quelle manuell, listed on the Kreditoren page', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  const kontoId = seedKonto(db);
  const kreditorId = createKreditor(db, { name: 'Muster AG', kontoId });
  const app = buildTestApp(db);

  const res = await request(app)
    .post('/admin/kreditoren/ibans')
    .set('x-test-person-id', '99')
    .type('form')
    .send({ iban: 'CH44 3199 9123 0008 8901 2', kreditorId: String(kreditorId) });

  assert.equal(res.status, 302);
  const { listKreditorIbansAll } = await import('../../../src/db/kreditorIbanRepo.js');
  const rows = listKreditorIbansAll(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].iban, 'CH4431999123000889012');
  assert.equal(rows[0].quelle, 'manuell');

  const seite = await request(app).get(`/admin/kreditoren/${kreditorId}/bearbeiten`).set('x-test-person-id', '99');
  assert.match(seite.text, /CH44 … 9012/);
  db.close();
});

test('POST /admin/kreditoren/ibans rejects an invalid IBAN', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  const kontoId = seedKonto(db);
  const kreditorId = createKreditor(db, { name: 'Muster AG', kontoId });
  const app = buildTestApp(db);

  const res = await request(app)
    .post('/admin/kreditoren/ibans')
    .set('x-test-person-id', '99')
    .type('form')
    .send({ iban: 'NICHT-EINE-IBAN', kreditorId: String(kreditorId) });

  assert.equal(res.status, 400);
  assert.match(res.text, /IBAN ist ungültig \(Prüfziffer oder Länge stimmt nicht\)\./);
  db.close();
});

test('POST /admin/kreditoren/ibans rejects an IBAN already mapped to another Lieferant', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  const kontoId = seedKonto(db);
  const kreditorA = createKreditor(db, { name: 'A AG', kontoId });
  const kreditorB = createKreditor(db, { name: 'B AG', kontoId });
  const { createKreditorIban } = await import('../../../src/db/kreditorIbanRepo.js');
  createKreditorIban(db, { kreditorId: kreditorA, iban: 'CH4431999123000889012' });
  const app = buildTestApp(db);

  const res = await request(app)
    .post('/admin/kreditoren/ibans')
    .set('x-test-person-id', '99')
    .type('form')
    .send({ iban: 'CH4431999123000889012', kreditorId: String(kreditorB) });

  assert.equal(res.status, 400);
  assert.match(res.text, /bereits einem Lieferanten zugeordnet/);
  db.close();
});

test('POST /admin/kreditoren/ibans/:id/loeschen removes the mapping', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  const kontoId = seedKonto(db);
  const kreditorId = kreditorOhneIbanPflicht(db, { name: 'Muster AG', kontoId });
  const { createKreditorIban, getKreditorIbanById } = await import('../../../src/db/kreditorIbanRepo.js');
  const ibanId = createKreditorIban(db, { kreditorId, iban: 'CH4431999123000889012' });
  const app = buildTestApp(db);

  const res = await request(app).post(`/admin/kreditoren/ibans/${ibanId}/loeschen`).set('x-test-person-id', '99');
  assert.equal(res.status, 302);
  assert.equal(getKreditorIbanById(db, ibanId), null);
  db.close();
});

test('GET /admin/kreditoren returns 200 for a Manager', async () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '55', vorname: 'Mana', nachname: 'Ger', email: 'manager@example.org', gruppen: ['30'], loggedInNow: true });
  const app = buildTestApp(db);
  const res = await request(app).get('/admin/kreditoren').set('x-test-person-id', '55');
  assert.equal(res.status, 200);
  db.close();
});

test('GET /admin/kreditoren returns 200 for a plain person with exactly this individual grant, and 403 for a different one', async () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'Nur', nachname: 'Konten', email: 'nur@example.org', gruppen: [], loggedInNow: true });
  setBerechtigungenForPerson(db, '1', ['konten_verwalten']);
  const app = buildTestApp(db);
  const res = await request(app).get('/admin/kreditoren').set('x-test-person-id', '1');
  assert.equal(res.status, 403);

  setBerechtigungenForPerson(db, '1', ['kreditoren_verwalten']);
  const res2 = await request(app).get('/admin/kreditoren').set('x-test-person-id', '1');
  assert.equal(res2.status, 200);
  db.close();
});

const post = (app, url, body) => request(app).post(url).set('x-test-person-id', '99').type('form').send(body);

test('POST /admin/kreditoren: Überweisung ohne IBAN wird abgelehnt, nichts angelegt', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  const app = buildTestApp(db);
  const res = await post(app, '/admin/kreditoren', { name: 'Neu AG', zahlungsart: 'ueberweisung' });
  assert.equal(res.status, 400);
  assert.match(res.text, /Bei Überweisung und Dauerauftrag ist mindestens eine IBAN Pflicht\./);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM kreditoren').get().n, 0);
  db.close();
});

test('POST /admin/kreditoren: Überweisung mit ausländischer IBAN legt Kreditor und IBAN an', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  const app = buildTestApp(db);
  const res = await post(app, '/admin/kreditoren', { name: 'Neu AG', zahlungsart: 'ueberweisung', iban: 'DE89 3704 0044 0532 0130 00' });
  assert.equal(res.status, 302);
  const k = db.prepare("SELECT * FROM kreditoren WHERE name = 'Neu AG'").get();
  assert.ok(k);
  const ibans = db.prepare('SELECT * FROM kreditor_ibans WHERE kreditor_id = ?').all(k.id);
  assert.equal(ibans.length, 1);
  assert.equal(ibans[0].iban, 'DE89370400440532013000');
  assert.equal(ibans[0].quelle, 'manuell');
  db.close();
});

test('POST /admin/kreditoren: ungültige oder doppelte IBAN legt keinen Kreditor an', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  kreditorMitIban(db, { name: 'Bestehend AG' });
  const app = buildTestApp(db);
  const a = await post(app, '/admin/kreditoren', { name: 'X AG', zahlungsart: 'ueberweisung', iban: 'CH00 0000 0000 0000 0000 0' });
  assert.equal(a.status, 400);
  const b = await post(app, '/admin/kreditoren', { name: 'Y AG', zahlungsart: 'ueberweisung', iban: 'CH93 0076 2011 6238 5295 7' });
  assert.equal(b.status, 400);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM kreditoren').get().n, 1);
  db.close();
});

test('POST /admin/kreditoren: Lastschrift ohne IBAN ist erlaubt', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  const app = buildTestApp(db);
  const res = await post(app, '/admin/kreditoren', { name: 'Last AG', zahlungsart: 'lastschrift' });
  assert.equal(res.status, 302);
  assert.equal(db.prepare("SELECT zahlungsart FROM kreditoren WHERE name = 'Last AG'").get().zahlungsart, 'lastschrift');
  db.close();
});

test('POST /admin/kreditoren/ibans: ungültige Prüfziffer wird abgelehnt', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  const id = kreditorOhneIbanPflicht(db, { name: 'Last AG' });
  const app = buildTestApp(db);
  const res = await post(app, '/admin/kreditoren/ibans', { iban: 'CH00 0000 0000 0000 0000 0', kreditorId: String(id) });
  assert.equal(res.status, 400);
  assert.match(res.text, /IBAN ist ungültig \(Prüfziffer oder Länge stimmt nicht\)\./);
  db.close();
});

test('IBAN löschen: letzte IBAN eines Überweisungs-Lieferanten bleibt, sonst weg', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  const id = kreditorMitIban(db, { name: 'Ueb AG' });
  const app = buildTestApp(db);
  const row = db.prepare('SELECT id FROM kreditor_ibans WHERE kreditor_id = ?').get(id);
  const res = await post(app, `/admin/kreditoren/ibans/${row.id}/loeschen`, {});
  assert.equal(res.status, 400);
  assert.match(res.text, /Die letzte IBAN kann nicht gelöscht werden, solange der Lieferant per Überweisung oder Dauerauftrag bezahlt wird\./);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM kreditor_ibans WHERE kreditor_id = ?').get(id).n, 1);
  db.close();
});

test('POST /admin/kreditoren/:id: Wechsel auf Dauerauftrag ohne IBAN abgelehnt; betragSchwankt gespeichert', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  const id = kreditorOhneIbanPflicht(db, { name: 'Last AG' });
  const app = buildTestApp(db);
  const bad = await post(app, `/admin/kreditoren/${id}`, { name: 'Last AG', kontoId: '', zahlungsart: 'dauerauftrag' });
  assert.equal(bad.status, 400);
  assert.equal(getKreditorById(db, id).zahlungsart, 'lastschrift');
  const ok = await post(app, `/admin/kreditoren/${id}`, { name: 'Last AG', kontoId: '', zahlungsart: 'lastschrift', betragSchwankt: 'on' });
  assert.equal(ok.status, 302);
  assert.equal(getKreditorById(db, id).betrag_schwankt, 1);
  db.close();
});

test('GET /admin/kreditoren: Badge IBAN fehlt, Zähler, Zahlungsart-Spalte', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  createKreditor(db, { name: 'Ohne AG', kontoId: null });
  kreditorMitIban(db, { name: 'Mit AG', zahlungsart: 'dauerauftrag', iban: 'CH4431999123000889012' });
  const app = buildTestApp(db);
  let res = await request(app).get('/admin/kreditoren').set('x-test-person-id', '99');
  assert.match(res.text, /IBAN fehlt/);
  assert.match(res.text, /1 Lieferant ohne IBAN/);
  assert.match(res.text, /Dauerauftrag/);
  assert.match(res.text, /1 IBAN · 0 Regeln/);
  createKreditor(db, { name: 'Noch eine AG', kontoId: null });
  res = await request(app).get('/admin/kreditoren').set('x-test-person-id', '99');
  assert.match(res.text, /2 Lieferanten ohne IBAN/);
  db.close();
});

// --- Buchungsart: das Standard-Konto eines Lieferanten steuert eingehende Rechnungen ---

function seedKontenMitArt(db) {
  for (const id of ['1', '2', '3', '4']) upsertPerson(db, { id, vorname: `P${id}`, nachname: 'M', email: `p${id}@example.org`, gruppen: [] });
  const k = (nr, art) => createKonto(db, { kontonummer: nr, bezeichnung: `Konto-${art}`, freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4', buchungsart: art });
  return { gutschrift: k('7001', 'gutschrift'), rechnung: k('7002', 'rechnung'), beides: k('7003', 'beides') };
}

test('Kreditor-Formular bietet kein reines Gutschrift-Konto als Standard-Konto an', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  seedKontenMitArt(db);
  const res = await request(buildTestApp(db)).get('/admin/kreditoren/neu').set('x-test-person-id', '99');
  assert.doesNotMatch(res.text, /Konto-gutschrift/);
  assert.match(res.text, /Konto-rechnung/);
  assert.match(res.text, /Konto-beides/);
  db.close();
});

test('Kreditor mit reinem Gutschrift-Konto als Standard-Konto wird beim Anlegen und Ändern abgelehnt', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  const konten = seedKontenMitArt(db);
  const app = buildTestApp(db);
  const res = await request(app).post('/admin/kreditoren').set('x-test-person-id', '99').type('form')
    .send({ name: 'Muster AG', zahlungsart: 'kreditkarte', kontoId: String(konten.gutschrift) });
  assert.equal(res.status, 400);
  assert.match(res.text, /Standard-Konto muss Rechnungen erlauben/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM kreditoren').get().n, 0);

  const ok = await request(app).post('/admin/kreditoren').set('x-test-person-id', '99').type('form')
    .send({ name: 'Muster AG', zahlungsart: 'kreditkarte', kontoId: String(konten.beides) });
  assert.equal(ok.status, 302);
  const id = db.prepare('SELECT id FROM kreditoren').get().id;
  const upd = await request(app).post(`/admin/kreditoren/${id}`).set('x-test-person-id', '99').type('form')
    .send({ name: 'Muster AG', zahlungsart: 'kreditkarte', kontoId: String(konten.gutschrift) });
  assert.equal(upd.status, 400);
  assert.equal(db.prepare('SELECT konto_id FROM kreditoren WHERE id = ?').get(id).konto_id, konten.beides);
  db.close();
});

test('Bearbeiten: ein schon gesetztes Standard-Konto bleibt sichtbar und wird beim Speichern nicht still geleert', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  const konten = seedKontenMitArt(db);
  const app = buildTestApp(db);
  await request(app).post('/admin/kreditoren').set('x-test-person-id', '99').type('form').send({ name: 'Alt AG', zahlungsart: 'kreditkarte', kontoId: String(konten.beides) });
  const id = db.prepare('SELECT id FROM kreditoren').get().id;
  db.prepare("UPDATE konten SET buchungsart = 'gutschrift' WHERE id = ?").run(konten.beides);
  const form = await request(app).get(`/admin/kreditoren/${id}/bearbeiten`).set('x-test-person-id', '99');
  assert.match(form.text, new RegExp(`<option value="${konten.beides}" selected>`));
  db.close();
});

// --- Kreditor-Seite: IBANs und Zuweisungsregeln je Kreditor statt globaler Listen ---

const seiteVon = (id) => `/admin/kreditoren/${id}/bearbeiten`;
const karte = (html, titel) => (html.match(new RegExp(`<section class="card[^"]*"[^>]*data-karte="${titel}"[\\s\\S]*?</section>`)) || [''])[0];

test('Liste: nur Kreditoren mit Zählern und «Öffnen», keine globalen IBAN-/Regel-Tabellen mehr', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  const a = kreditorMitIban(db, { name: 'Alpha AG', iban: 'CH4431999123000889012' });
  const { createKreditorIban } = await import('../../../src/db/kreditorIbanRepo.js');
  createKreditorIban(db, { kreditorId: a, iban: 'CH9300762011623852957' });
  createZuweisungsregel(db, { absenderMuster: 'alpha.ch', kreditorId: a });
  kreditorOhneIbanPflicht(db, { name: 'Beta AG' });
  const res = await request(buildTestApp(db)).get('/admin/kreditoren').set('x-test-person-id', '99');
  assert.equal(res.status, 200);
  assert.match(res.text, /2 IBANs · 1 Regel/);
  assert.match(res.text, /0 IBANs · 0 Regeln/);
  assert.match(res.text, new RegExp(`href="/admin/kreditoren/${a}/bearbeiten"[^>]*>Öffnen<`));
  assert.doesNotMatch(res.text, />Bearbeiten</);
  assert.doesNotMatch(res.text, /action="\/admin\/kreditoren\/regeln"/);
  assert.doesNotMatch(res.text, /action="\/admin\/kreditoren\/ibans"/);
  assert.doesNotMatch(res.text, /alpha\.ch/);
  assert.doesNotMatch(res.text, /CH44 … 9012/);
  assert.doesNotMatch(res.text, /name="kreditorId"/);
  db.close();
});

test('Kreditor-Seite: Titel = Name, drei Karten, nur eigene IBANs und Regeln, Formulare ohne Auswahlfeld', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  const a = kreditorMitIban(db, { name: 'Alpha AG', iban: 'CH4431999123000889012' });
  const b = kreditorMitIban(db, { name: 'Beta AG', iban: 'CH9300762011623852957' });
  createZuweisungsregel(db, { absenderMuster: 'alpha.ch', kreditorId: a });
  createZuweisungsregel(db, { absenderMuster: 'beta.ch', kreditorId: b });
  const res = await request(buildTestApp(db)).get(seiteVon(a)).set('x-test-person-id', '99');
  assert.equal(res.status, 200);
  assert.match(res.text, /<h1 class="seitenkopf-titel">Alpha AG<\/h1>/);
  assert.match(res.text, /href="\/admin\/kreditoren"[^>]*>Zurück zur Liste</);
  assert.match(karte(res.text, 'stammdaten'), new RegExp(`action="/admin/kreditoren/${a}"`));
  const ibans = karte(res.text, 'ibans');
  assert.match(ibans, /CH44 … 9012/);
  assert.doesNotMatch(ibans, /CH93 … 2957/);
  assert.match(ibans, /action="\/admin\/kreditoren\/ibans"/);
  assert.match(ibans, new RegExp(`<input type="hidden" name="kreditorId" value="${a}">`));
  assert.match(ibans, /unabhängigen Quelle/);
  assert.doesNotMatch(ibans, /<select/);
  const regeln = karte(res.text, 'regeln');
  assert.match(regeln, /alpha\.ch/);
  assert.doesNotMatch(regeln, /beta\.ch/);
  assert.match(regeln, /action="\/admin\/kreditoren\/regeln"/);
  assert.match(regeln, new RegExp(`<input type="hidden" name="kreditorId" value="${a}">`));
  assert.doesNotMatch(regeln, /<select/);
  db.close();
});

test('IBAN hinzufügen und löschen leiten auf die Kreditor-Seite zurück; Fehler erscheinen dort mit Eingabe', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  const id = kreditorOhneIbanPflicht(db, { name: 'Last AG' });
  const app = buildTestApp(db);
  const ok = await post(app, '/admin/kreditoren/ibans', { iban: 'CH44 3199 9123 0008 8901 2', kreditorId: String(id) });
  assert.equal(ok.status, 302);
  assert.equal(ok.headers.location, `${seiteVon(id)}?gespeichert=1`);

  const fehler = await post(app, '/admin/kreditoren/ibans', { iban: 'CH00 0000 0000 0000 0000 0', kreditorId: String(id) });
  assert.equal(fehler.status, 400);
  assert.match(fehler.text, /<h1 class="seitenkopf-titel">Last AG<\/h1>/);
  assert.match(karte(fehler.text, 'ibans'), /IBAN ist ungültig/);
  assert.match(karte(fehler.text, 'ibans'), /value="CH00 0000 0000 0000 0000 0"/);

  const row = db.prepare('SELECT id FROM kreditor_ibans WHERE kreditor_id = ?').get(id);
  const weg = await post(app, `/admin/kreditoren/ibans/${row.id}/loeschen`, {});
  assert.equal(weg.status, 302);
  assert.equal(weg.headers.location, `${seiteVon(id)}?gespeichert=1`);
  db.close();
});

test('Letzte IBAN löschen: Fehler erscheint auf der Kreditor-Seite', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  const id = kreditorMitIban(db, { name: 'Ueb AG' });
  const row = db.prepare('SELECT id FROM kreditor_ibans WHERE kreditor_id = ?').get(id);
  const res = await post(buildTestApp(db), `/admin/kreditoren/ibans/${row.id}/loeschen`, {});
  assert.equal(res.status, 400);
  assert.match(res.text, /<h1 class="seitenkopf-titel">Ueb AG<\/h1>/);
  assert.match(karte(res.text, 'ibans'), /Die letzte IBAN kann nicht gelöscht werden/);
  db.close();
});

test('Regel hinzufügen, bearbeiten und löschen leiten auf die Kreditor-Seite; Fehler dort mit Eingabe', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  const id = kreditorOhneIbanPflicht(db, { name: 'Last AG' });
  const app = buildTestApp(db);
  const ok = await post(app, '/admin/kreditoren/regeln', { absenderMuster: 'last.ch', kreditorId: String(id) });
  assert.equal(ok.status, 302);
  assert.equal(ok.headers.location, `${seiteVon(id)}?gespeichert=1`);
  const regelId = db.prepare("SELECT id FROM zuweisungsregeln WHERE absender_muster = 'last.ch'").get().id;

  const fehler = await post(app, '/admin/kreditoren/regeln', { absenderMuster: 'kein muster', kreditorId: String(id) });
  assert.equal(fehler.status, 400);
  assert.match(fehler.text, /<h1 class="seitenkopf-titel">Last AG<\/h1>/);
  assert.match(karte(fehler.text, 'regeln'), /Absender-Muster muss eine gültige E-Mail-Adresse oder Domain sein/);
  assert.match(karte(fehler.text, 'regeln'), /value="kein muster"/);

  const formular = await request(app).get(`/admin/kreditoren/regeln/${regelId}/bearbeiten`).set('x-test-person-id', '99');
  assert.match(formular.text, new RegExp(`href="${seiteVon(id)}"[^>]*>Zurück`));
  const gespeichert = await post(app, `/admin/kreditoren/regeln/${regelId}`, { absenderMuster: 'last2.ch', kreditorId: String(id) });
  assert.equal(gespeichert.headers.location, `${seiteVon(id)}?gespeichert=1`);

  const weg = await post(app, `/admin/kreditoren/regeln/${regelId}/loeschen`, {});
  assert.equal(weg.status, 302);
  assert.equal(weg.headers.location, `${seiteVon(id)}?gespeichert=1`);
  assert.equal(getZuweisungsregelById(db, regelId), null);
  db.close();
});

test('Manipulierte kreditorId (unbekannt, leer, inaktiv) wird bei IBAN und Regel abgewiesen, nichts angelegt', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  const aktiv = kreditorOhneIbanPflicht(db, { name: 'Aktiv AG' });
  const inaktiv = kreditorOhneIbanPflicht(db, { name: 'Inaktiv AG' });
  db.prepare('UPDATE kreditoren SET aktiv = 0 WHERE id = ?').run(inaktiv);
  const regelId = createZuweisungsregel(db, { absenderMuster: 'aktiv.ch', kreditorId: aktiv });
  const app = buildTestApp(db);
  for (const kreditorId of ['99999', '', 'abc', String(inaktiv)]) {
    const iban = await post(app, '/admin/kreditoren/ibans', { iban: 'CH4431999123000889012', kreditorId });
    assert.ok([400, 404].includes(iban.status), `IBAN mit kreditorId=${kreditorId}: ${iban.status}`);
    const regel = await post(app, '/admin/kreditoren/regeln', { absenderMuster: 'neu.ch', kreditorId });
    assert.ok([400, 404].includes(regel.status), `Regel mit kreditorId=${kreditorId}: ${regel.status}`);
    const umhaengen = await post(app, `/admin/kreditoren/regeln/${regelId}`, { absenderMuster: 'aktiv.ch', kreditorId });
    assert.equal(umhaengen.status, 400, `Umhängen auf kreditorId=${kreditorId}`);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM kreditor_ibans').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM zuweisungsregeln').get().n, 1);
  assert.equal(getZuweisungsregelById(db, regelId).kreditor_id, aktiv);

  // Inaktiver Kreditor: Seite zeigt keine Anlegeformulare, nur den Hinweis.
  const seite = await request(app).get(seiteVon(inaktiv)).set('x-test-person-id', '99');
  assert.equal(seite.status, 200);
  assert.doesNotMatch(seite.text, /action="\/admin\/kreditoren\/ibans"/);
  assert.doesNotMatch(seite.text, /action="\/admin\/kreditoren\/regeln"/);
  assert.match(seite.text, /deaktiviert/);
  db.close();
});

test('Neuer Kreditor mit Absender legt Kreditor und Regel an und öffnet die Kreditor-Seite', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  const app = buildTestApp(db);
  const neu = await request(app).get('/admin/kreditoren/neu').set('x-test-person-id', '99');
  assert.match(neu.text, /name="absenderMuster"/);
  assert.match(neu.text, /Absender \(E-Mail-Adresse oder Domain\)/);

  const res = await post(app, '/admin/kreditoren', { name: 'Neu AG', zahlungsart: 'lastschrift', absenderMuster: 'neu-ag.ch' });
  assert.equal(res.status, 302);
  const k = db.prepare("SELECT id FROM kreditoren WHERE name = 'Neu AG'").get();
  assert.equal(res.headers.location, `${seiteVon(k.id)}?gespeichert=1`);
  assert.equal(db.prepare('SELECT kreditor_id FROM zuweisungsregeln WHERE absender_muster = ?').get('neu-ag.ch').kreditor_id, k.id);

  const ohne = await post(app, '/admin/kreditoren', { name: 'Ohne AG', zahlungsart: 'lastschrift', absenderMuster: '' });
  assert.equal(ohne.status, 302);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM zuweisungsregeln').get().n, 1);
  db.close();
});

test('Neuer Kreditor mit ungültigem oder schon vergebenem Absender: Fehler im Formular, weder Kreditor noch Regel noch IBAN', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  const alt = kreditorOhneIbanPflicht(db, { name: 'Alt AG' });
  createZuweisungsregel(db, { absenderMuster: 'vergeben.ch', kreditorId: alt });
  const app = buildTestApp(db);
  const a = await post(app, '/admin/kreditoren', { name: 'X AG', zahlungsart: 'ueberweisung', iban: 'CH93 0076 2011 6238 5295 7', absenderMuster: 'ch' });
  assert.equal(a.status, 400);
  assert.match(a.text, /<h1[^>]*>Neuer Kreditor<\/h1>/);
  assert.match(a.text, /Absender-Muster muss eine gültige E-Mail-Adresse oder Domain sein/);
  assert.match(a.text, /value="X AG"/);
  assert.match(a.text, /name="absenderMuster"[^>]*value="ch"/);
  const b = await post(app, '/admin/kreditoren', { name: 'Y AG', zahlungsart: 'lastschrift', absenderMuster: 'vergeben.ch' });
  assert.equal(b.status, 400);
  assert.match(b.text, /bereits einem Kreditor zugewiesen/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM kreditoren').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM zuweisungsregeln').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM kreditor_ibans').get().n, 0);
  db.close();
});

test('Stammdaten speichern führt zurück auf die Kreditor-Seite; Fehler dort mit IBAN- und Regel-Karte', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  const id = kreditorOhneIbanPflicht(db, { name: 'Last AG' });
  createZuweisungsregel(db, { absenderMuster: 'last.ch', kreditorId: id });
  const app = buildTestApp(db);
  const ok = await post(app, `/admin/kreditoren/${id}`, { name: 'Last AG', kontoId: '', zahlungsart: 'lastschrift' });
  assert.equal(ok.headers.location, `${seiteVon(id)}?gespeichert=1`);
  const fehler = await post(app, `/admin/kreditoren/${id}`, { name: '', kontoId: '', zahlungsart: 'lastschrift' });
  assert.equal(fehler.status, 400);
  assert.match(karte(fehler.text, 'stammdaten'), /Name ist ein Pflichtfeld/);
  assert.match(karte(fehler.text, 'regeln'), /last\.ch/);
  db.close();
});
