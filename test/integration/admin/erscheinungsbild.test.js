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
import { loadCurrentPerson, requireRole } from '../../../src/middleware/roles.js';
import { createErscheinungsbildRouter } from '../../../src/routes/admin/erscheinungsbild.js';

function buildTestApp(db, brandingDir) {
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
  const config = { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20' }, brandingDir };
  app.use(loadCurrentPerson(db));
  app.use('/admin/erscheinungsbild', requireRole(config, 'portal-admin'), createErscheinungsbildRouter({ db, config }));
  return app;
}

function seedAdmin(db) {
  upsertPerson(db, { id: '99', vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'], loggedInNow: true });
}

const ERSCHEINUNGSBILD_ROUTES = [
  { method: 'get', path: '/admin/erscheinungsbild' },
  { method: 'post', path: '/admin/erscheinungsbild' },
];

test('every Erscheinungsbild route returns 401 without any session, and config is untouched', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  const brandingDir = mkdtempSync(join(tmpdir(), 'branding-test-'));
  const app = buildTestApp(db, brandingDir);
  for (const { method, path } of ERSCHEINUNGSBILD_ROUTES) {
    const res = await request(app)[method](path).type('form').send({ primaryColor: '#111111', secondaryColor: '#222222', themeDefault: 'hell' });
    assert.equal(res.status, 401, `${method.toUpperCase()} ${path} should be 401 without a session`);
  }
  assert.equal(getConfigValue(db, 'branding_farbe_primaer'), '#2f4858');
  db.close();
  rmSync(brandingDir, { recursive: true, force: true });
});

test('every Erscheinungsbild route returns 403 for a logged-in non-admin (buchhaltung only)', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  upsertPerson(db, { id: '77', vorname: 'Nur', nachname: 'Buchhaltung', email: 'b@example.org', gruppen: ['10'], loggedInNow: true });
  const brandingDir = mkdtempSync(join(tmpdir(), 'branding-test-'));
  const app = buildTestApp(db, brandingDir);
  for (const { method, path } of ERSCHEINUNGSBILD_ROUTES) {
    const res = await request(app)[method](path).set('x-test-person-id', '77').type('form').send({ primaryColor: '#111111', secondaryColor: '#222222', themeDefault: 'hell' });
    assert.equal(res.status, 403, `${method.toUpperCase()} ${path} should be 403 for a non-admin`);
  }
  db.close();
  rmSync(brandingDir, { recursive: true, force: true });
});

test('POST /admin/erscheinungsbild with valid colors and theme persists them, no file', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  const brandingDir = mkdtempSync(join(tmpdir(), 'branding-test-'));
  const app = buildTestApp(db, brandingDir);
  const res = await request(app)
    .post('/admin/erscheinungsbild')
    .set('x-test-person-id', '99')
    .field('primaryColor', '#123456')
    .field('secondaryColor', '#abcdef')
    .field('themeDefault', 'dunkel');
  assert.equal(res.status, 302);
  assert.equal(getConfigValue(db, 'branding_farbe_primaer'), '#123456');
  assert.equal(getConfigValue(db, 'branding_theme_default'), 'dunkel');
  db.close();
  rmSync(brandingDir, { recursive: true, force: true });
});

test('POST /admin/erscheinungsbild with an invalid hex color is rejected, config untouched', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  const brandingDir = mkdtempSync(join(tmpdir(), 'branding-test-'));
  const app = buildTestApp(db, brandingDir);
  const res = await request(app)
    .post('/admin/erscheinungsbild')
    .set('x-test-person-id', '99')
    .field('primaryColor', 'not-a-color')
    .field('secondaryColor', '#abcdef')
    .field('themeDefault', 'system');
  assert.equal(res.status, 400);
  assert.equal(getConfigValue(db, 'branding_farbe_primaer'), '#2f4858');
  db.close();
  rmSync(brandingDir, { recursive: true, force: true });
});

test('POST /admin/erscheinungsbild with a valid PNG logo saves it and it is servable', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  const brandingDir = mkdtempSync(join(tmpdir(), 'branding-test-'));
  const app = buildTestApp(db, brandingDir);

  const pngBytes = Buffer.from('89504e470d0a1a0a', 'hex');
  const res = await request(app)
    .post('/admin/erscheinungsbild')
    .set('x-test-person-id', '99')
    .field('primaryColor', '#2f4858')
    .field('secondaryColor', '#4d7ea8')
    .field('themeDefault', 'system')
    .attach('logo', pngBytes, { filename: 'logo.png', contentType: 'image/png' });

  assert.equal(res.status, 302);
  assert.equal(getConfigValue(db, 'branding_logo_mimetype'), 'image/png');
  const pfad = getConfigValue(db, 'branding_logo_pfad');
  assert.ok(pfad.startsWith(brandingDir));
  db.close();
  rmSync(brandingDir, { recursive: true, force: true });
});

test('POST /admin/erscheinungsbild rejects a non-image file', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  const brandingDir = mkdtempSync(join(tmpdir(), 'branding-test-'));
  const app = buildTestApp(db, brandingDir);

  const res = await request(app)
    .post('/admin/erscheinungsbild')
    .set('x-test-person-id', '99')
    .field('primaryColor', '#2f4858')
    .field('secondaryColor', '#4d7ea8')
    .field('themeDefault', 'system')
    .attach('logo', Buffer.from('not an image'), { filename: 'evil.txt', contentType: 'text/plain' });

  assert.equal(res.status, 400);
  assert.equal(getConfigValue(db, 'branding_logo_pfad'), null);
  db.close();
  rmSync(brandingDir, { recursive: true, force: true });
});

test('POST /admin/erscheinungsbild rejects a file whose declared Content-Type is spoofed as image/png but whose bytes are not a real PNG/JPEG', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  const brandingDir = mkdtempSync(join(tmpdir(), 'branding-test-'));
  const app = buildTestApp(db, brandingDir);

  const res = await request(app)
    .post('/admin/erscheinungsbild')
    .set('x-test-person-id', '99')
    .field('primaryColor', '#2f4858')
    .field('secondaryColor', '#4d7ea8')
    .field('themeDefault', 'system')
    .attach('logo', Buffer.from('not actually a png'), { filename: 'evil.png', contentType: 'image/png' });

  assert.equal(res.status, 400);
  assert.equal(getConfigValue(db, 'branding_logo_pfad'), null);
  db.close();
  rmSync(brandingDir, { recursive: true, force: true });
});
