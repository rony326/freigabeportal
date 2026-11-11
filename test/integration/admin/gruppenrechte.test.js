import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { openDatabase } from '../../../src/db/index.js';
import { upsertPerson } from '../../../src/db/personenRepo.js';
import { loadCurrentPerson } from '../../../src/middleware/roles.js';
import { loadNavFlags } from '../../../src/middleware/nav.js';
import { requirePermission, personHasPermission } from '../../../src/middleware/permissions.js';
import { auditContext } from '../../../src/services/auditContext.js';
import { listGruppenBerechtigungen, setGruppenBerechtigungen } from '../../../src/db/gruppenBerechtigungenRepo.js';
import { GRANTABLE_BERECHTIGUNGEN, BERECHTIGUNG_LABELS } from '../../../src/services/berechtigungKatalog.js';
import { createGruppenrechteRouter } from '../../../src/routes/admin/gruppenrechte.js';

const config = { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20', groupIdManager: '30' } };

function buildTestApp(db) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', new URL('../../../views', import.meta.url).pathname);
  app.use((req, res, next) => {
    res.locals.branding = { primaryColor: '#000', secondaryColor: '#fff', hasLogo: false, themeAttr: null };
    next();
  });
  app.use(express.urlencoded({ extended: true }));
  app.use((req, res, next) => {
    req.session = { personId: req.headers['x-test-person-id'] };
    next();
  });
  app.use(loadCurrentPerson(db));
  app.use(auditContext);
  app.use(loadNavFlags(db, config));
  app.use('/admin/gruppenrechte', requirePermission(db, config, 'gruppenrechte_verwalten'), createGruppenrechteRouter({ db, config }));
  return app;
}

function seed(db) {
  upsertPerson(db, { id: '99', vorname: 'Admina', nachname: 'Portal', email: 'a@example.org', gruppen: ['20'], loggedInNow: true });
  upsertPerson(db, { id: '55', vorname: 'Mana', nachname: 'Ger', email: 'm@example.org', gruppen: ['30'], loggedInNow: true });
}

const audit = (db) => db.prepare("SELECT * FROM audit_ereignisse WHERE objekt = 'gruppenrechte' ORDER BY id").all();

test('ohne Session 401, als Manager 403', async () => {
  const db = openDatabase(':memory:');
  seed(db);
  const app = buildTestApp(db);
  assert.equal((await request(app).get('/admin/gruppenrechte')).status, 401);
  assert.equal((await request(app).get('/admin/gruppenrechte').set('x-test-person-id', '55')).status, 403);
  assert.equal((await request(app).post('/admin/gruppenrechte').set('x-test-person-id', '55').type('form').send({})).status, 403);
  db.close();
});

test('GET zeigt eine Zeile pro Recht und die drei Gruppen', async () => {
  const db = openDatabase(':memory:');
  seed(db);
  const res = await request(buildTestApp(db)).get('/admin/gruppenrechte').set('x-test-person-id', '99');
  assert.equal(res.status, 200);
  for (const recht of [...GRANTABLE_BERECHTIGUNGEN, 'gruppenrechte_verwalten']) {
    assert.ok(res.text.includes(BERECHTIGUNG_LABELS[recht].replaceAll('&', '&amp;')), recht);
  }
  for (const gruppe of ['superadmin', 'manager', 'buchhaltung']) assert.match(res.text, new RegExp(`name="recht_${gruppe}"`));
  db.close();
});

test('POST ändert Manager-Rechte, schreibt Audit und wirkt sofort', async () => {
  const db = openDatabase(':memory:');
  seed(db);
  const app = buildTestApp(db);
  const res = await request(app).post('/admin/gruppenrechte').set('x-test-person-id', '99').type('form')
    .send({ recht_superadmin: GRANTABLE_BERECHTIGUNGEN, recht_manager: ['kreditoren_verwalten', 'audit_log_einsehen'], recht_buchhaltung: ['kreditoren_verwalten'] });
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /gespeichert=1/);
  assert.deepEqual(listGruppenBerechtigungen(db, 'manager'), ['audit_log_einsehen', 'kreditoren_verwalten']);
  assert.deepEqual(listGruppenBerechtigungen(db, 'buchhaltung'), ['kreditoren_verwalten']);
  const manager = { churchtools_person_id: '55', gruppen: ['30'] };
  assert.equal(personHasPermission(db, config, manager, 'konten_verwalten'), false);
  assert.equal(personHasPermission(db, config, manager, 'audit_log_einsehen'), true);
  const zeilen = audit(db);
  assert.ok(zeilen.some((z) => z.objekt_id === 'manager' && z.aktion === 'recht_entzogen' && JSON.parse(z.nachher).recht === 'konten_verwalten'));
  assert.ok(zeilen.some((z) => z.objekt_id === 'buchhaltung' && z.aktion === 'recht_erteilt' && JSON.parse(z.nachher).recht === 'kreditoren_verwalten'));
  assert.equal(zeilen[0].person_id, '99');
  db.close();
});

test('gruppenrechte_verwalten lässt sich nicht abschalten und nicht anderen Gruppen geben', async () => {
  const db = openDatabase(':memory:');
  seed(db);
  const app = buildTestApp(db);
  await request(app).post('/admin/gruppenrechte').set('x-test-person-id', '99').type('form')
    .send({ recht_superadmin: [], recht_manager: ['gruppenrechte_verwalten', 'konten_verwalten'], recht_buchhaltung: ['gruppenrechte_verwalten'] });
  assert.ok(listGruppenBerechtigungen(db, 'superadmin').includes('gruppenrechte_verwalten'));
  assert.deepEqual(listGruppenBerechtigungen(db, 'manager'), ['konten_verwalten']);
  assert.deepEqual(listGruppenBerechtigungen(db, 'buchhaltung'), []);
  const nochDrin = await request(app).get('/admin/gruppenrechte').set('x-test-person-id', '99');
  assert.equal(nochDrin.status, 200);
  db.close();
});

test('POST ohne Änderung schreibt keine Audit-Einträge', async () => {
  const db = openDatabase(':memory:');
  seed(db);
  setGruppenBerechtigungen(db, 'manager', ['konten_verwalten']);
  const app = buildTestApp(db);
  await request(app).post('/admin/gruppenrechte').set('x-test-person-id', '99').type('form')
    .send({ recht_superadmin: GRANTABLE_BERECHTIGUNGEN, recht_manager: ['konten_verwalten'], recht_buchhaltung: [] });
  assert.equal(audit(db).length, 0);
  db.close();
});

test('Schlägt das Audit fehl, wird auch die Rechteänderung zurückgenommen (eine Transaktion)', async () => {
  const db = openDatabase(':memory:');
  seed(db);
  const vorher = listGruppenBerechtigungen(db, 'manager');
  db.exec("CREATE TRIGGER test_audit_kaputt BEFORE INSERT ON audit_ereignisse WHEN NEW.objekt = 'gruppenrechte' BEGIN SELECT RAISE(ABORT, 'kaputt'); END;");
  const app = buildTestApp(db);
  app.use((err, req, res, next) => res.status(500).send('fehler'));
  const res = await request(app).post('/admin/gruppenrechte').set('x-test-person-id', '99').type('form')
    .send({ recht_superadmin: GRANTABLE_BERECHTIGUNGEN, recht_manager: ['konten_verwalten'], recht_buchhaltung: [] });
  assert.equal(res.status, 500);
  assert.deepEqual(listGruppenBerechtigungen(db, 'manager'), vorher);
  assert.equal(db.isTransaction, false);
  db.close();
});
