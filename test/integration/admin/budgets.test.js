import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { openDatabase } from '../../../src/db/index.js';
import { upsertPerson } from '../../../src/db/personenRepo.js';
import { createKonto } from '../../../src/db/kontenRepo.js';
import { getBudget, setzeBudget } from '../../../src/db/budgetRepo.js';
import { setBerechtigungenForPerson } from '../../../src/db/personBerechtigungenRepo.js';
import { loadCurrentPerson } from '../../../src/middleware/roles.js';
import { loadNavFlags } from '../../../src/middleware/nav.js';
import { requirePermission } from '../../../src/middleware/permissions.js';
import { createBudgetsRouter } from '../../../src/routes/admin/budgets.js';

export function buildTestApp(db) {
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
  app.use('/admin/budgets', requirePermission(db, config, 'budgets_verwalten'), createBudgetsRouter({ db }));
  return app;
}

export function seed(db) {
  for (const id of ['1', '2']) upsertPerson(db, { id, vorname: `Person${id}`, nachname: 'Muster', email: `p${id}@x.ch`, gruppen: [], loggedInNow: true });
  upsertPerson(db, { id: '7', vorname: 'Kurt', nachname: 'Kassier', email: 'k@x.ch', gruppen: [], loggedInNow: true });
  setBerechtigungenForPerson(db, '7', ['budgets_verwalten']);
  const a = Number(createKonto(db, { kontonummer: '4000', bezeichnung: 'Jugend', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '2', stellvertreter2Id: '1' }));
  const b = Number(createKonto(db, { kontonummer: '4100', bezeichnung: 'Musik', freigeber1Id: '2', stellvertreter1Id: '1', freigeber2Id: '1', stellvertreter2Id: '2' }));
  return { a, b };
}

test('Budgets: ohne Recht 403, mit Recht 200 und alle aktiven Konten mit Freigeber 1 und Vorjahr', async () => {
  const db = openDatabase(':memory:');
  const { a } = seed(db);
  setzeBudget(db, { kontoId: a, jahr: 2025, betrag: 1200, personId: '7' });
  const app = buildTestApp(db);
  assert.equal((await request(app).get('/admin/budgets').set('x-test-person-id', '1')).status, 403);
  assert.equal((await request(app).post('/admin/budgets').set('x-test-person-id', '1').type('form').send({ jahr: '2026', [`budget_${a}`]: '5' })).status, 403);
  assert.equal(getBudget(db, a, 2026), null);
  const res = await request(app).get('/admin/budgets?jahr=2026').set('x-test-person-id', '7');
  assert.equal(res.status, 200);
  assert.match(res.text, /4000/);
  assert.match(res.text, /4100/);
  assert.match(res.text, /Person1 Muster/);
  assert.match(res.text, new RegExp(`name="budget_${a}"`));
  assert.match(res.text, /Vorjahr: CHF 1&#39;200.00/);
  db.close();
});

test('Budgets: speichern, leeren entfernt, Beträge im Schweizer Format', async () => {
  const db = openDatabase(':memory:');
  const { a, b } = seed(db);
  setzeBudget(db, { kontoId: b, jahr: 2026, betrag: 300, personId: '7' });
  const app = buildTestApp(db);
  const res = await request(app).post('/admin/budgets').set('x-test-person-id', '7').type('form')
    .send({ jahr: '2026', [`budget_${a}`]: "12'000.–", [`budget_${b}`]: '' });
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /\/admin\/budgets\?jahr=2026&gespeichert=1/);
  assert.equal(getBudget(db, a, 2026), 12000);
  assert.equal(getBudget(db, b, 2026), null);
  db.close();
});

test('Budgets: ungültiger Betrag → 400, nichts gespeichert (auch keine gültigen Felder)', async () => {
  const db = openDatabase(':memory:');
  const { a, b } = seed(db);
  const app = buildTestApp(db);
  const res = await request(app).post('/admin/budgets').set('x-test-person-id', '7').type('form')
    .send({ jahr: '2026', [`budget_${a}`]: '500', [`budget_${b}`]: 'viel' });
  assert.equal(res.status, 400);
  assert.match(res.text, /4100/);
  assert.match(res.text, /is-invalid/);
  assert.match(res.text, /value="viel"/);
  assert.equal(getBudget(db, a, 2026), null);
  assert.equal(getBudget(db, b, 2026), null);
  db.close();
});

test('Budgets: ungültiges Jahr → 400', async () => {
  const db = openDatabase(':memory:');
  seed(db);
  const app = buildTestApp(db);
  const res = await request(app).post('/admin/budgets').set('x-test-person-id', '7').type('form').send({ jahr: '1850' });
  assert.equal(res.status, 400);
  const get = await request(app).get('/admin/budgets?jahr=abc').set('x-test-person-id', '7');
  assert.equal(get.status, 200);
  assert.match(get.text, new RegExp(`value="${new Date().getFullYear()}"`));
  db.close();
});

test('Budgets erscheinen in der Admin-Navigation nur mit budgets_verwalten', async () => {
  const db = openDatabase(':memory:');
  seed(db);
  setBerechtigungenForPerson(db, '1', ['konten_verwalten']);
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', new URL('../../../views', import.meta.url).pathname);
  const config = { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20', groupIdManager: '30' } };
  app.use((req, res, next) => { req.session = { personId: req.headers['x-test-person-id'] }; next(); });
  app.use(loadCurrentPerson(db));
  app.use(loadNavFlags(db, config));
  app.get('/admin/x', (req, res) => res.json(res.locals.navigation.gruppen.flatMap((g) => g.punkte.map((p) => p.href))));
  const mit = await request(app).get('/admin/x').set('x-test-person-id', '7');
  const ohne = await request(app).get('/admin/x').set('x-test-person-id', '1');
  assert.ok(mit.body.includes('/admin/budgets'));
  assert.ok(!ohne.body.includes('/admin/budgets'));
  db.close();
});
