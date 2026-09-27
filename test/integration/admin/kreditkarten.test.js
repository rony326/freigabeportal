import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { openDatabase } from '../../../src/db/index.js';
import { upsertPerson } from '../../../src/db/personenRepo.js';
import { seedDefaults } from '../../../src/db/adminConfigRepo.js';
import { getKreditkarteById, listErfasserIds, createKreditkarte } from '../../../src/db/kreditkartenRepo.js';
import { loadCurrentPerson } from '../../../src/middleware/roles.js';
import { loadNavFlags } from '../../../src/middleware/nav.js';
import { requirePermission } from '../../../src/middleware/permissions.js';
import { createKreditkartenAdminRouter } from '../../../src/routes/admin/kreditkarten.js';
import { setBerechtigungenForPerson } from '../../../src/db/personBerechtigungenRepo.js';

const config = { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20' } };

function buildApp(db) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', new URL('../../../views', import.meta.url).pathname);
  app.use((req, res, next) => { res.locals.branding = { primaryColor: '#000', secondaryColor: '#fff', hasLogo: false, themeAttr: null }; next(); });
  app.use(express.urlencoded({ extended: false }));
  app.use((req, res, next) => { req.session = { personId: req.headers['x-test-person-id'] }; next(); });
  app.use(loadCurrentPerson(db));
  app.use(loadNavFlags(db, config));
  app.use('/admin/kreditkarten', requirePermission(db, config, 'kreditkarten_verwalten'), createKreditkartenAdminRouter({ db }));
  return app;
}

function setup() {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  upsertPerson(db, { id: '1', vorname: 'Ad', nachname: 'Min', email: 'a@example.org', gruppen: ['20'] });
  upsertPerson(db, { id: '2', vorname: 'Ver', nachname: 'Antwortlich', email: 'v@example.org', gruppen: [] });
  upsertPerson(db, { id: '3', vorname: 'Er', nachname: 'Fasser', email: 'e@example.org', gruppen: [] });
  return db;
}

test('GET /admin/kreditkarten is 403 without kreditkarten_verwalten, 200 with it', async () => {
  const db = setup();
  const app = buildApp(db);
  assert.equal((await request(app).get('/admin/kreditkarten').set('x-test-person-id', '3')).status, 403);
  setBerechtigungenForPerson(db, '3', ['kreditkarten_verwalten']);
  assert.equal((await request(app).get('/admin/kreditkarten').set('x-test-person-id', '3')).status, 200);
  db.close();
});

test('POST /admin/kreditkarten creates a card in Modus B with an Erfasser list', async () => {
  const db = setup();
  const res = await request(buildApp(db))
    .post('/admin/kreditkarten')
    .set('x-test-person-id', '1')
    .type('form')
    .send({ bezeichnung: 'Visa Jugend', karteEndziffern: '4242', karteninhaberName: 'Anna', verantwortlichId: '2', erfasserIds: ['3'] });
  assert.equal(res.status, 302);
  const karte = getKreditkarteById(db, 1);
  assert.equal(karte.erfassung_offen, 0);
  assert.equal(karte.verantwortlich_id, '2');
  assert.deepEqual(listErfasserIds(db, 1), ['3']);
  db.close();
});

test('POST /admin/kreditkarten rejects bad Endziffern and a missing Bezeichnung with 400', async () => {
  const db = setup();
  const res = await request(buildApp(db))
    .post('/admin/kreditkarten')
    .set('x-test-person-id', '1')
    .type('form')
    .send({ bezeichnung: '', karteEndziffern: '4242 1111', verantwortlichId: '2', erfassungOffen: '1' });
  assert.equal(res.status, 400);
  assert.match(res.text, /Bezeichnung/);
  assert.match(res.text, /vier Ziffern/);
  assert.equal(getKreditkarteById(db, 1), null);
  db.close();
});

test('deaktivieren/aktivieren toggles the card', async () => {
  const db = setup();
  const id = createKreditkarte(db, { bezeichnung: 'A', verantwortlichId: '2', erfassungOffen: true });
  const app = buildApp(db);
  await request(app).post(`/admin/kreditkarten/${id}/deaktivieren`).set('x-test-person-id', '1');
  assert.equal(getKreditkarteById(db, id).aktiv, 0);
  await request(app).post(`/admin/kreditkarten/${id}/aktivieren`).set('x-test-person-id', '1');
  assert.equal(getKreditkarteById(db, id).aktiv, 1);
  db.close();
});
