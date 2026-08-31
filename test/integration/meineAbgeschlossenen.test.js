import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createKonto } from '../../src/db/kontenRepo.js';
import { createJob, setKontierung } from '../../src/db/jobsRepo.js';
import { loadCurrentPerson, requireLogin } from '../../src/middleware/roles.js';
import { loadNavFlags } from '../../src/middleware/nav.js';
import { createMeineAbgeschlossenenRouter } from '../../src/routes/meineAbgeschlossenen.js';

function buildTestApp(db) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', new URL('../../views', import.meta.url).pathname);
  app.use((req, res, next) => {
    res.locals.branding = { primaryColor: '#000', secondaryColor: '#fff', hasLogo: false, themeAttr: null };
    next();
  });
  app.use((req, res, next) => {
    req.session = { personId: req.headers['x-test-person-id'] };
    next();
  });
  const config = { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20' }, downloadSigningSecret: 'test-secret' };
  app.use(loadCurrentPerson(db));
  app.use(loadNavFlags(db, config));
  app.use('/meine-abgeschlossenen', requireLogin(), createMeineAbgeschlossenenRouter({ db }));
  return app;
}

function seedBuchhaltungPerson(db, id = '50') {
  upsertPerson(db, { id, vorname: 'Buch', nachname: 'Halter', email: `${id}@example.org`, gruppen: ['10'], loggedInNow: true });
}

test('GET /meine-abgeschlossenen returns 401 without a session', async () => {
  const db = openDatabase(':memory:');
  const app = buildTestApp(db);
  const res = await request(app).get('/meine-abgeschlossenen');
  assert.equal(res.status, 401);
  db.close();
});

test('GET /meine-abgeschlossenen shows the empty-state text when there are no abgeschlossen jobs for this person', async () => {
  const db = openDatabase(':memory:');
  seedBuchhaltungPerson(db);
  const app = buildTestApp(db);
  const res = await request(app).get('/meine-abgeschlossenen').set('x-test-person-id', '50');
  assert.equal(res.status, 200);
  assert.match(res.text, /Keine abgeschlossenen Rechnungen\./);
  db.close();
});

test('GET /meine-abgeschlossenen lists an abgeschlossen job with a "Jetzt prüfen" link and pending-timestamp status', async () => {
  const db = openDatabase(':memory:');
  seedBuchhaltungPerson(db, '50');
  for (const id of ['1', '2', '3']) {
    upsertPerson(db, { id, vorname: `Person${id}`, nachname: 'Muster', email: `p${id}@example.org`, gruppen: ['10'], loggedInNow: false });
  }
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '50', stellvertreter2Id: '3' });
  const id = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'fertig.pdf', pdfPfad: '/tmp/a.pdf' });
  setKontierung(db, id, kontoId);
  db.prepare("UPDATE jobs SET status = 'abgeschlossen' WHERE id = ?").run(id);
  const app = buildTestApp(db);

  const res = await request(app).get('/meine-abgeschlossenen').set('x-test-person-id', '50');
  assert.equal(res.status, 200);
  assert.match(res.text, new RegExp(`id="abgeschlossen-row-${id}"`));
  assert.match(res.text, new RegExp(`/zeitstempel-pruefen\\?jobId=${id}`));
  assert.match(res.text, /ausstehend/);
  assert.match(res.text, /1 Rechnungen/);
  db.close();
});

test('GET /meine-abgeschlossenen shows a set zeitstempel_gesetzt_am, and still a "Jetzt prüfen" link for an abgeholt job (falls back to upload-and-hash-compare)', async () => {
  const db = openDatabase(':memory:');
  seedBuchhaltungPerson(db, '50');
  for (const id of ['1', '2', '3']) {
    upsertPerson(db, { id, vorname: `Person${id}`, nachname: 'Muster', email: `p${id}@example.org`, gruppen: ['10'], loggedInNow: false });
  }
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '50', stellvertreter2Id: '3' });
  const id = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'abgeholt.pdf', pdfPfad: '/tmp/a.pdf' });
  setKontierung(db, id, kontoId);
  db.prepare("UPDATE jobs SET status = 'abgeholt', zeitstempel_gesetzt_am = '2026-08-20T10:00:00.000Z' WHERE id = ?").run(id);
  const app = buildTestApp(db);

  const res = await request(app).get('/meine-abgeschlossenen').set('x-test-person-id', '50');
  assert.equal(res.status, 200);
  const rowMatch = res.text.match(new RegExp(`<tr id="abgeschlossen-row-${id}">[\\s\\S]*?</tr>`));
  assert.ok(rowMatch, 'expected a row for the abgeholt job');
  assert.match(rowMatch[0], /gesetzt am 2026-08-20T10:00:00\.000Z/);
  assert.match(rowMatch[0], new RegExp(`href="/zeitstempel-pruefen\\?jobId=${id}"`), 'verify link stays available even once abgeholt');
  db.close();
});

test('GET /meine-abgeschlossenen paginates: page 1 shows the newest 20, page 2 shows the rest, with working Zurück/Weiter links', async () => {
  const db = openDatabase(':memory:');
  seedBuchhaltungPerson(db, '50');
  for (const id of ['1', '2', '3']) {
    upsertPerson(db, { id, vorname: `Person${id}`, nachname: 'Muster', email: `p${id}@example.org`, gruppen: ['10'], loggedInNow: false });
  }
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '50', stellvertreter2Id: '3' });
  const ids = [];
  for (let i = 0; i < 25; i += 1) {
    const eingangAm = new Date(Date.UTC(2026, 0, 1, 0, i, 0)).toISOString();
    const id = createJob(db, { eingangAm, quelle: 'scanner', absender: null, dateiname: `a${i}.pdf`, pdfPfad: '/tmp/a.pdf' });
    setKontierung(db, id, kontoId);
    db.prepare("UPDATE jobs SET status = 'abgeschlossen' WHERE id = ?").run(id);
    ids.push(id);
  }
  const app = buildTestApp(db);

  const seite1 = await request(app).get('/meine-abgeschlossenen').set('x-test-person-id', '50');
  assert.equal(seite1.status, 200);
  assert.match(seite1.text, /25 Rechnungen/);
  assert.match(seite1.text, new RegExp(`id="abgeschlossen-row-${ids[24]}"`), 'newest job is on page 1');
  assert.doesNotMatch(seite1.text, new RegExp(`id="abgeschlossen-row-${ids[0]}"`), 'oldest job is not on page 1');
  assert.match(seite1.text, /Seite 1 von 2/);
  assert.match(seite1.text, /href="\?seite=2">Weiter</);

  const seite2 = await request(app).get('/meine-abgeschlossenen?seite=2').set('x-test-person-id', '50');
  assert.equal(seite2.status, 200);
  assert.match(seite2.text, new RegExp(`id="abgeschlossen-row-${ids[0]}"`), 'oldest job is on page 2');
  assert.match(seite2.text, /Seite 2 von 2/);
  assert.match(seite2.text, /href="\?seite=1">Zurück</);
  db.close();
});
