import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createKonto } from '../../src/db/kontenRepo.js';
import { createSpesenabrechnung } from '../../src/db/spesenabrechnungenRepo.js';
import { createSpesenPosition, ablehnenJob } from '../../src/db/jobsRepo.js';
import { loadCurrentPerson, requireLogin } from '../../src/middleware/roles.js';
import { loadNavFlags } from '../../src/middleware/nav.js';
import { createMeineSpesenRouter } from '../../src/routes/meineSpesen.js';

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
  app.use('/meine-spesen', requireLogin(), createMeineSpesenRouter({ db }));
  return app;
}

function seedEinreicher(db, id = '60') {
  upsertPerson(db, { id, vorname: 'Ein', nachname: 'Reicher', email: `${id}@example.org`, gruppen: [], loggedInNow: true });
}

function seedKontoPersonen(db) {
  for (const id of ['51', '52', '53']) {
    upsertPerson(db, { id, vorname: `Person${id}`, nachname: 'Muster', email: `p${id}@example.org`, gruppen: [] });
  }
}

test('GET /meine-spesen returns 401 without a session', async () => {
  const db = openDatabase(':memory:');
  const app = buildTestApp(db);
  const res = await request(app).get('/meine-spesen');
  assert.equal(res.status, 401);
  db.close();
});

test('GET /meine-spesen shows the empty-state text when this person has no Spesen-Einreichungen', async () => {
  const db = openDatabase(':memory:');
  seedEinreicher(db);
  const app = buildTestApp(db);
  const res = await request(app).get('/meine-spesen').set('x-test-person-id', '60');
  assert.equal(res.status, 200);
  assert.match(res.text, /Keine eigenen Spesen-Einreichungen\./);
  db.close();
});

test('GET /meine-spesen shows every Spesen job the current person submitted, including rejected ones', async () => {
  const db = openDatabase(':memory:');
  seedEinreicher(db);
  seedKontoPersonen(db);
  const kontoId = createKonto(db, { kontonummer: '1000', bezeichnung: 'Reisespesen', freigeber1Id: '51', stellvertreter1Id: '52', freigeber2Id: '53', stellvertreter2Id: '51' });
  const spesenabrechnungId = createSpesenabrechnung(db, { eingereichtVon: '60', eingereichtAm: '2026-08-31T08:00:00.000Z', titel: null });
  const abgelehntId = createSpesenPosition(db, {
    eingangAm: '2026-08-31T08:00:00.000Z', eingereichtVon: '60', kontoId, betrag: '10.00', auslageDatum: '2026-08-20',
    beschreibung: 'Taxi', dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf', thumbnailPfad: null, spesenabrechnungId,
    zugewiesenAn: '51', freigabe1EskaliertVon: null, freigabe1Eskalationsgrund: null,
  });
  ablehnenJob(db, abgelehntId, { abgelehntVon: '51', grund: 'Kein Beleg' });
  const app = buildTestApp(db);
  const res = await request(app).get('/meine-spesen').set('x-test-person-id', '60');
  assert.equal(res.status, 200);
  assert.match(res.text, /Meine Spesen/);
  assert.match(res.text, /Taxi/);
  assert.match(res.text, /Kein Beleg/);
  db.close();
});

test('GET /meine-spesen shows the Zeitstempel status and a "Jetzt prüfen" link for an abgeschlossen Spesen position', async () => {
  const db = openDatabase(':memory:');
  seedEinreicher(db);
  seedKontoPersonen(db);
  const kontoId = createKonto(db, { kontonummer: '1000', bezeichnung: 'Reisespesen', freigeber1Id: '51', stellvertreter1Id: '52', freigeber2Id: '53', stellvertreter2Id: '51' });
  const spesenabrechnungId = createSpesenabrechnung(db, { eingereichtVon: '60', eingereichtAm: '2026-08-31T08:00:00.000Z', titel: null });
  const jobId = createSpesenPosition(db, {
    eingangAm: '2026-08-31T08:00:00.000Z', eingereichtVon: '60', kontoId, betrag: '10.00', auslageDatum: '2026-08-20',
    beschreibung: 'Taxi', dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf', thumbnailPfad: null, spesenabrechnungId,
    zugewiesenAn: '51', freigabe1EskaliertVon: null, freigabe1Eskalationsgrund: null,
  });
  db.prepare("UPDATE jobs SET status = 'abgeschlossen' WHERE id = ?").run(jobId);
  const app = buildTestApp(db);

  const res = await request(app).get('/meine-spesen').set('x-test-person-id', '60');
  const rowMatch = res.text.match(new RegExp(`<tr id="spesen-meine-row-${jobId}">[\\s\\S]*?</tr>`));
  assert.ok(rowMatch, 'expected a row for the Spesen position');
  assert.match(rowMatch[0], /ausstehend/, 'no zeitstempel_gesetzt_am set yet');
  assert.match(rowMatch[0], new RegExp(`href="/zeitstempel-pruefen\\?jobId=${jobId}"`));
  db.close();
});
