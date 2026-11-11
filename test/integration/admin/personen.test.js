// test/integration/admin/personen.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { openDatabase } from '../../../src/db/index.js';
import { upsertPerson, setFerienmodus, deactivatePerson } from '../../../src/db/personenRepo.js';
import { loadCurrentPerson, requireAnyRole, requireRole } from '../../../src/middleware/roles.js';
import { loadNavFlags } from '../../../src/middleware/nav.js';
import { createPersonenRouter } from '../../../src/routes/admin/personen.js';
import { listBerechtigungenForPerson } from '../../../src/db/personBerechtigungenRepo.js';

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
  app.use('/admin/personen', requireAnyRole(config, ['superadmin', 'manager']), createPersonenRouter({ db, config }));
  return app;
}

test('GET /admin/personen without a logged-in session returns 401', async () => {
  const db = openDatabase(':memory:');
  const app = buildTestApp(db);
  const res = await request(app).get('/admin/personen');
  assert.equal(res.status, 401);
  db.close();
});

test('GET /admin/personen returns 403 for a logged-in non-admin (buchhaltung only)', async () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '77', vorname: 'Nur', nachname: 'Buchhaltung', email: 'b@example.org', gruppen: ['10'], loggedInNow: true });
  const app = buildTestApp(db);
  const res = await request(app).get('/admin/personen').set('x-test-person-id', '77');
  assert.equal(res.status, 403);
  db.close();
});

test('GET /admin/personen returns 200 for a Manager', async () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '55', vorname: 'Mana', nachname: 'Ger', email: 'manager@example.org', gruppen: ['30'], loggedInNow: true });
  const app = buildTestApp(db);
  const res = await request(app).get('/admin/personen').set('x-test-person-id', '55');
  assert.equal(res.status, 200);
  db.close();
});

test('GET /admin/personen lists all persons including inactive ones, and flags unresolved persons', async () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '99', vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'], loggedInNow: true });
  upsertPerson(db, { id: '1', vorname: 'Aktiv', nachname: 'Person', email: 'a@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '2', vorname: 'Inaktiv', nachname: 'Person', email: 'i@example.org', gruppen: ['10'], loggedInNow: false });
  db.prepare('UPDATE personen SET aktiv = 0 WHERE churchtools_person_id = ?').run('2');
  upsertPerson(db, { id: '3', vorname: 'Unresolved', nachname: 'Person', email: 'u@example.org', gruppen: ['10'], loggedInNow: false });
  db.prepare('UPDATE personen SET ct_person_unresolved = 1 WHERE churchtools_person_id = ?').run('3');

  const app = buildTestApp(db);
  const res = await request(app).get('/admin/personen').set('x-test-person-id', '99');
  assert.equal(res.status, 200);
  assert.match(res.text, /Aktiv Person/);
  assert.match(res.text, /Inaktiv Person/);
  assert.match(res.text, /Unresolved Person/);
  assert.match(res.text, /nicht auflösbar/);
  db.close();
});

test('GET /admin/personen labels portal users without an administrative group neutrally, and shows why access was withdrawn', async () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '99', vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'], loggedInNow: true });
  upsertPerson(db, { id: '4', vorname: 'Konto', nachname: 'Referenziert', email: 'k@example.org', gruppen: [], loggedInNow: false });
  upsertPerson(db, { id: '5', vorname: 'Geloescht', nachname: 'Person', email: 'g@example.org', gruppen: [], loggedInNow: false });
  deactivatePerson(db, '5', 'churchtools_geloescht');

  const app = buildTestApp(db);
  const res = await request(app).get('/admin/personen').set('x-test-person-id', '99');
  assert.equal(res.status, 200);
  assert.match(res.text, /Keine Verwaltungsgruppe – Portalzugang über ChurchTools-Login/);
  assert.match(res.text, /Zugang entzogen: Person in ChurchTools gelöscht/);

  const adminRow = res.text.slice(res.text.indexOf('Admina Portal'), res.text.indexOf('Admina Portal') + 500);
  assert.doesNotMatch(adminRow, /Keine Verwaltungsgruppe/, 'a person still in a real ChurchTools group must not be labelled');
  db.close();
});

test('GET /admin/personen shows a role badge per person and rights checkboxes, disabled for a Manager viewer', async () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '99', vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'], loggedInNow: true });
  upsertPerson(db, { id: '55', vorname: 'Mana', nachname: 'Ger', email: 'manager@example.org', gruppen: ['30'], loggedInNow: false });
  const app = buildTestApp(db);

  const asSuperadmin = await request(app).get('/admin/personen').set('x-test-person-id', '99');
  assert.match(asSuperadmin.text, /Superadmin/);
  assert.match(asSuperadmin.text, /Manager/);
  // Note: the assertion is scoped to <tbody> (not the whole page) because the shared
  // _brand_styles.ejs partial legitimately contains the substring "disabled" in unrelated
  // Bootstrap CSS custom-property names (e.g. --bs-btn-disabled-bg) on every page.
  const superadminTbody = asSuperadmin.text.slice(asSuperadmin.text.indexOf('<tbody>'), asSuperadmin.text.indexOf('</tbody>'));
  assert.doesNotMatch(superadminTbody, /disabled/, 'superadmin must be able to edit the checkboxes');

  const asManager = await request(app).get('/admin/personen').set('x-test-person-id', '55');
  assert.equal(asManager.status, 200);
  const managerTbody = asManager.text.slice(asManager.text.indexOf('<tbody>'), asManager.text.indexOf('</tbody>'));
  assert.match(managerTbody, /disabled/, 'manager must see read-only checkboxes');
  db.close();
});

test('POST /admin/personen/:id/berechtigungen returns 403 for a Manager', async () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '55', vorname: 'Mana', nachname: 'Ger', email: 'manager@example.org', gruppen: ['30'], loggedInNow: true });
  upsertPerson(db, { id: '1', vorname: 'Ziel', nachname: 'Person', email: 'z@example.org', gruppen: [], loggedInNow: false });
  const app = buildTestApp(db);
  const res = await request(app)
    .post('/admin/personen/1/berechtigungen')
    .type('form')
    .set('x-test-person-id', '55')
    .send({ berechtigungen: ['konten_verwalten'] });
  assert.equal(res.status, 403);
  db.close();
});

test('POST /admin/personen/:id/berechtigungen sets the given rights for a Superadmin, and clears them when none are submitted', async () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '99', vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'], loggedInNow: true });
  upsertPerson(db, { id: '1', vorname: 'Ziel', nachname: 'Person', email: 'z@example.org', gruppen: [], loggedInNow: false });
  const app = buildTestApp(db);

  const res = await request(app)
    .post('/admin/personen/1/berechtigungen')
    .type('form')
    .set('x-test-person-id', '99')
    .send({ berechtigungen: ['konten_verwalten', 'mails_einsehen'] });
  assert.equal(res.status, 302);
  assert.deepEqual(listBerechtigungenForPerson(db, '1').sort(), ['konten_verwalten', 'mails_einsehen']);

  await request(app).post('/admin/personen/1/berechtigungen').type('form').set('x-test-person-id', '99').send({});
  assert.deepEqual(listBerechtigungenForPerson(db, '1'), []);
  db.close();
});

test('POST /admin/personen/:id/berechtigungen ignores a value outside the catalog instead of crashing', async () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '99', vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'], loggedInNow: true });
  upsertPerson(db, { id: '1', vorname: 'Ziel', nachname: 'Person', email: 'z@example.org', gruppen: [], loggedInNow: false });
  const app = buildTestApp(db);
  const res = await request(app)
    .post('/admin/personen/1/berechtigungen')
    .type('form')
    .set('x-test-person-id', '99')
    .send({ berechtigungen: ['konten_verwalten', 'basis_einstellungen'] });
  assert.equal(res.status, 302);
  assert.deepEqual(listBerechtigungenForPerson(db, '1'), ['konten_verwalten']);
  db.close();
});

test('POST /admin/personen/:id/berechtigungen returns 404 for a person that does not exist', async () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '99', vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'], loggedInNow: true });
  const app = buildTestApp(db);
  const res = await request(app)
    .post('/admin/personen/does-not-exist/berechtigungen')
    .type('form')
    .set('x-test-person-id', '99')
    .send({ berechtigungen: ['konten_verwalten'] });
  assert.equal(res.status, 404);
  db.close();
});

test('GET /admin/personen shows the Ferienmodus period and Stellvertreter name for a person with an active/planned vacation', async () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'], loggedInNow: true });
  upsertPerson(db, { id: '2', vorname: 'Bo', nachname: 'Muster', email: 'bo@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '3', vorname: 'Cé', nachname: 'Muster', email: 'ce@example.org', gruppen: ['10'], loggedInNow: false });
  setFerienmodus(db, '2', { von: '2026-09-10', bis: '2026-09-24', stellvertreterId: '3' });

  const app = buildTestApp(db);
  const res = await request(app).get('/admin/personen').set('x-test-person-id', '1');
  assert.equal(res.status, 200);
  assert.match(res.text, /2026-09-10/);
  assert.match(res.text, /Cé Muster/);
  db.close();
});

const herkunftZeile = (html, recht) => (html.match(new RegExp(`<li[^>]*data-herkunft="${recht}"[^>]*>[\\s\\S]*?</li>`)) || [''])[0];

test('Personenliste zeigt pro Recht die Herkunft: direkt und über Gruppe', async () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '99', vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'], loggedInNow: true });
  upsertPerson(db, { id: '55', vorname: 'Mana', nachname: 'Ger', email: 'manager@example.org', gruppen: ['30'], loggedInNow: true });
  db.prepare("INSERT INTO person_berechtigungen (person_id, berechtigung) VALUES ('55', 'workflow_eingreifen')").run();
  const res = await request(buildTestApp(db)).get('/admin/personen').set('x-test-person-id', '99');
  assert.equal(res.status, 200);
  assert.match(herkunftZeile(res.text, 'workflow_eingreifen'), /direkt/);
  assert.match(herkunftZeile(res.text, 'konten_verwalten'), /über Gruppe Manager/);
  assert.doesNotMatch(herkunftZeile(res.text, 'konten_verwalten'), /direkt/);
  db.close();
});

test('Person in Superadmin und Buchhaltung: Herkunft nennt beide Gruppen', async () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '99', vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20', '10'], loggedInNow: true });
  db.prepare("INSERT INTO gruppen_berechtigungen (gruppe, berechtigung) VALUES ('buchhaltung', 'kreditoren_verwalten')").run();
  const res = await request(buildTestApp(db)).get('/admin/personen').set('x-test-person-id', '99');
  const zeile = herkunftZeile(res.text, 'kreditoren_verwalten');
  assert.match(zeile, /Superadmin/);
  assert.match(zeile, /Buchhaltung/);
  db.close();
});

test('Einzelrecht-Checkbox eines Rechts, das eine Gruppe liefert, trägt den Hinweis und bleibt bedienbar', async () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '99', vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'], loggedInNow: true });
  upsertPerson(db, { id: '55', vorname: 'Mana', nachname: 'Ger', email: 'manager@example.org', gruppen: ['30'], loggedInNow: true });
  const res = await request(buildTestApp(db)).get('/admin/personen').set('x-test-person-id', '99');
  const box = res.text.match(/<input[^>]*id="berechtigung-55-konten_verwalten"[^>]*>/)[0];
  assert.doesNotMatch(box, /disabled/);
  assert.match(res.text, /for="berechtigung-55-konten_verwalten">[^<]*<\/label>\s*<span[^>]*>auch über Gruppe Manager/);
  db.close();
});

test('Speichern der Einzelrechte ist im Audit-Log nachvollziehbar (Trigger auf person_berechtigungen)', async () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '99', vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'], loggedInNow: true });
  upsertPerson(db, { id: '55', vorname: 'Mana', nachname: 'Ger', email: 'manager@example.org', gruppen: ['30'], loggedInNow: true });
  const res = await request(buildTestApp(db)).post('/admin/personen/55/berechtigungen').set('x-test-person-id', '99').type('form').send({ berechtigungen: ['workflow_eingreifen'] });
  assert.equal(res.status, 302);
  const z = db.prepare("SELECT nachher FROM audit_ereignisse WHERE objekt = 'person_berechtigungen'").all();
  assert.equal(z.length, 1);
  assert.match(z[0].nachher, /workflow_eingreifen/);
  db.close();
});
