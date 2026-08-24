import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../../src/db/index.js';
import { seedDefaults, getConfigValue } from '../../../src/db/adminConfigRepo.js';
import { upsertPerson } from '../../../src/db/personenRepo.js';
import { loadCurrentPerson } from '../../../src/middleware/roles.js';
import { loadNavFlags } from '../../../src/middleware/nav.js';
import { requireRole } from '../../../src/middleware/roles.js';
import { createBackupRouter } from '../../../src/routes/admin/backup.js';

function buildTestApp(db, config) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', new URL('../../../views', import.meta.url).pathname);
  app.use((req, res, next) => {
    res.locals.branding = { primaryColor: '#000', secondaryColor: '#fff', hasLogo: false, themeAttr: null, seitenTitel: 'Test' };
    next();
  });
  app.use(express.urlencoded({ extended: false }));
  app.use((req, res, next) => {
    req.session = { personId: req.headers['x-test-person-id'] };
    next();
  });
  app.use(loadCurrentPerson(db));
  app.use(loadNavFlags(db, config));
  app.use('/admin/backup', requireRole(config, 'superadmin'), createBackupRouter({ db, config }));
  return app;
}

function seedSuperadmin(db) {
  upsertPerson(db, { id: '99', vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'], loggedInNow: true });
}

function testConfig(dir) {
  return {
    churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20', groupIdManager: '30' },
    backupDir: join(dir, 'backups'),
    jobsDir: join(dir, 'jobs'),
    brandingDir: join(dir, 'branding'),
  };
}

test('GET /admin/backup returns 401 without a session', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'backup-route-test-'));
  const db = openDatabase(':memory:');
  seedDefaults(db);
  const app = buildTestApp(db, testConfig(dir));
  const res = await request(app).get('/admin/backup');
  assert.equal(res.status, 401);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('GET /admin/backup returns 403 for a Manager (superadmin-only, not manager-accessible)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'backup-route-test-'));
  const db = openDatabase(':memory:');
  seedDefaults(db);
  upsertPerson(db, { id: '55', vorname: 'Mana', nachname: 'Ger', email: 'm@example.org', gruppen: ['30'], loggedInNow: true });
  const app = buildTestApp(db, testConfig(dir));
  const res = await request(app).get('/admin/backup').set('x-test-person-id', '55');
  assert.equal(res.status, 403);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('GET /admin/backup returns 200 for a superadmin with the configured schedule pre-filled', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'backup-route-test-'));
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedSuperadmin(db);
  const app = buildTestApp(db, testConfig(dir));
  const res = await request(app).get('/admin/backup').set('x-test-person-id', '99');
  assert.equal(res.status, 200);
  assert.match(res.text, /id="cronStunde"[^>]*value="3"/);
  assert.match(res.text, /id="aufbewahrungAnzahl"[^>]*value="14"/);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('POST /admin/backup persists a valid schedule and rejects an out-of-range hour', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'backup-route-test-'));
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedSuperadmin(db);
  const app = buildTestApp(db, testConfig(dir));

  const ok = await request(app)
    .post('/admin/backup')
    .set('x-test-person-id', '99')
    .type('form')
    .send({ cronStunde: '4', cronMinute: '30', aufbewahrungAnzahl: '7' });
  assert.equal(ok.status, 302);
  assert.equal(getConfigValue(db, 'backup_cron_stunde'), '4');
  assert.equal(getConfigValue(db, 'backup_aufbewahrung_anzahl'), '7');

  const bad = await request(app)
    .post('/admin/backup')
    .set('x-test-person-id', '99')
    .type('form')
    .send({ cronStunde: '24', cronMinute: '30', aufbewahrungAnzahl: '7' });
  assert.equal(bad.status, 400);
  assert.match(bad.text, /Ganzzahl zwischen 0 und 23/);
  assert.equal(getConfigValue(db, 'backup_cron_stunde'), '4', 'rejected POST must not touch config');

  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('POST /admin/backup/jetzt-ausfuehren creates a backup file and shows a success banner', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'backup-route-test-'));
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedSuperadmin(db);
  const app = buildTestApp(db, testConfig(dir));

  const triggerRes = await request(app).post('/admin/backup/jetzt-ausfuehren').set('x-test-person-id', '99');
  assert.equal(triggerRes.status, 302);
  assert.equal(triggerRes.headers.location, '/admin/backup?getriggert=1');

  const res = await request(app).get(triggerRes.headers.location).set('x-test-person-id', '99');
  assert.equal(res.status, 200);
  assert.match(res.text, /alert-success/);
  assert.match(res.text, /Erfolgreich gesichert/);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('GET /admin/backup/dateien/:name downloads an existing backup and 404s on a path-traversal attempt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'backup-route-test-'));
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedSuperadmin(db);
  const app = buildTestApp(db, testConfig(dir));

  await request(app).post('/admin/backup/jetzt-ausfuehren').set('x-test-person-id', '99');
  const list = await request(app).get('/admin/backup').set('x-test-person-id', '99');
  const [, dateiname] = list.text.match(/\/admin\/backup\/dateien\/([^"]+)"/);

  const okRes = await request(app).get(`/admin/backup/dateien/${dateiname}`).set('x-test-person-id', '99');
  assert.equal(okRes.status, 200);
  assert.equal(okRes.headers['content-type'], 'application/zip');

  const traversalRes = await request(app)
    .get('/admin/backup/dateien/..%2F..%2Fetc%2Fpasswd')
    .set('x-test-person-id', '99');
  assert.equal(traversalRes.status, 404);

  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('POST /admin/backup/dateien/:name/loeschen removes the file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'backup-route-test-'));
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedSuperadmin(db);
  const app = buildTestApp(db, testConfig(dir));

  await request(app).post('/admin/backup/jetzt-ausfuehren').set('x-test-person-id', '99');
  const before = await request(app).get('/admin/backup').set('x-test-person-id', '99');
  const [, dateiname] = before.text.match(/\/admin\/backup\/dateien\/([^"]+)"/);

  const delRes = await request(app).post(`/admin/backup/dateien/${dateiname}/loeschen`).set('x-test-person-id', '99');
  assert.equal(delRes.status, 302);

  const after = await request(app).get('/admin/backup').set('x-test-person-id', '99');
  assert.doesNotMatch(after.text, new RegExp(dateiname));

  db.close();
  rmSync(dir, { recursive: true, force: true });
});
