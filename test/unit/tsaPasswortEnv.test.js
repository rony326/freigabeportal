import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { openDatabase } from '../../src/db/index.js';
import { seedDefaults, getConfigValue, getConfigValues, setConfigValue } from '../../src/db/adminConfigRepo.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { loadCurrentPerson, requireRole } from '../../src/middleware/roles.js';
import { loadNavFlags } from '../../src/middleware/nav.js';
import { createZeitstempelAdminRouter } from '../../src/routes/admin/zeitstempel.js';

// S7: Die Umgebungsvariable TSA_PASSWORT hat Vorrang vor dem Wert in admin_config.
function mitEnv(wert, fn) {
  const alt = process.env.TSA_PASSWORT;
  if (wert === undefined) delete process.env.TSA_PASSWORT; else process.env.TSA_PASSWORT = wert;
  return Promise.resolve(fn()).finally(() => {
    if (alt === undefined) delete process.env.TSA_PASSWORT; else process.env.TSA_PASSWORT = alt;
  });
}

test('TSA_PASSWORT gesetzt: getConfigValue liefert die Umgebungsvariable, der DB-Wert bleibt unberührt', async () => {
  await mitEnv('aus-der-umgebung', () => {
    const db = openDatabase(':memory:');
    seedDefaults(db);
    setConfigValue(db, 'zeitstempel_tsa_passwort', 'aus-der-db');
    assert.equal(getConfigValue(db, 'zeitstempel_tsa_passwort'), 'aus-der-umgebung');
    assert.equal(getConfigValues(db, ['zeitstempel_tsa_passwort']).zeitstempel_tsa_passwort, 'aus-der-umgebung');
    assert.equal(db.prepare("SELECT value FROM admin_config WHERE key = 'zeitstempel_tsa_passwort'").get().value, 'aus-der-db');
    db.close();
  });
});

test('TSA_PASSWORT nicht gesetzt oder leer: Rückfall auf den DB-Wert', async () => {
  for (const wert of [undefined, '']) {
    await mitEnv(wert, () => {
      const db = openDatabase(':memory:');
      seedDefaults(db);
      setConfigValue(db, 'zeitstempel_tsa_passwort', 'aus-der-db');
      assert.equal(getConfigValue(db, 'zeitstempel_tsa_passwort'), 'aus-der-db');
      db.close();
    });
  }
});

test('Andere Schlüssel werden von TSA_PASSWORT nie beeinflusst', async () => {
  await mitEnv('x', () => {
    const db = openDatabase(':memory:');
    seedDefaults(db);
    setConfigValue(db, 'zeitstempel_tsa_user', 'meinuser');
    assert.equal(getConfigValue(db, 'zeitstempel_tsa_user'), 'meinuser');
    db.close();
  });
});

function baueApp(db) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', new URL('../../views', import.meta.url).pathname);
  app.use((req, res, next) => {
    res.locals.branding = { primaryColor: '#000', secondaryColor: '#fff', hasLogo: false, themeAttr: null, seitenTitel: 'Freigabeportal' };
    next();
  });
  app.use(express.urlencoded({ extended: false }));
  app.use((req, res, next) => { req.session = { personId: '99' }; next(); });
  const config = { publicBaseUrl: 'https://portal.example.org', churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20', groupIdManager: '30' } };
  app.use(loadCurrentPerson(db));
  app.use(loadNavFlags(db, config));
  app.use('/admin/zeitstempel', requireRole(config, 'superadmin'), createZeitstempelAdminRouter({ db, config, mailer: { async sendMail() {} } }));
  return app;
}

test('Formular: mit TSA_PASSWORT erscheint ein Hinweis, das Passwort selbst nie', async () => {
  await mitEnv('supergeheim-umgebung', async () => {
    const db = openDatabase(':memory:');
    seedDefaults(db);
    upsertPerson(db, { id: '99', vorname: 'A', nachname: 'B', email: 'a@example.org', gruppen: ['20'], loggedInNow: true });
    setConfigValue(db, 'zeitstempel_tsa_passwort', 'supergeheim-db');
    const res = await request(baueApp(db)).get('/admin/zeitstempel');
    assert.equal(res.status, 200);
    assert.match(res.text, /TSA_PASSWORT/);
    assert.match(res.text, /Umgebungsvariable/);
    assert.doesNotMatch(res.text, /supergeheim/);
    db.close();
  });
});

test('Formular: ohne TSA_PASSWORT kein Umgebungs-Hinweis', async () => {
  await mitEnv(undefined, async () => {
    const db = openDatabase(':memory:');
    seedDefaults(db);
    upsertPerson(db, { id: '99', vorname: 'A', nachname: 'B', email: 'a@example.org', gruppen: ['20'], loggedInNow: true });
    const res = await request(baueApp(db)).get('/admin/zeitstempel');
    assert.equal(res.status, 200);
    assert.doesNotMatch(res.text, /id="tsaPasswortUmgebung"/);
    db.close();
  });
});
