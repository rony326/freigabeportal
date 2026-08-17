import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createKonto } from '../../src/db/kontenRepo.js';
import { createJob, claimJob, setKontierung, setThumbnailPfad, ablehnenJob, updateKontierungMetadaten } from '../../src/db/jobsRepo.js';
import { loadCurrentPerson, requireLogin } from '../../src/middleware/roles.js';
import { loadNavFlags } from '../../src/middleware/nav.js';
import { createPoolPageRouter } from '../../src/routes/poolPage.js';

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
  app.use(loadNavFlags(config));
  app.use('/pool', requireLogin(), createPoolPageRouter({ db, config }));
  return app;
}

function seedBuchhaltungPerson(db, id = '50') {
  upsertPerson(db, { id, vorname: 'Buch', nachname: 'Halter', email: `${id}@example.org`, gruppen: ['10'], loggedInNow: true });
}

test('GET /pool returns 401 without a session', async () => {
  const db = openDatabase(':memory:');
  const app = buildTestApp(db);
  const res = await request(app).get('/pool');
  assert.equal(res.status, 401);
  db.close();
});

test('GET /pool carries a viewport meta tag and wraps the Pool table in table-responsive', async () => {
  const db = openDatabase(':memory:');
  seedBuchhaltungPerson(db);
  createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'rechnung.pdf', pdfPfad: '/tmp/a.pdf' });
  const app = buildTestApp(db);
  const res = await request(app).get('/pool').set('x-test-person-id', '50');
  assert.match(res.text, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  assert.match(res.text, /<div class="table-responsive">/);
  db.close();
});

test('GET /pool shows the quelle and absender that n8n submitted with the job', async () => {
  const db = openDatabase(':memory:');
  seedBuchhaltungPerson(db);
  createJob(db, {
    eingangAm: '2026-08-15T08:00:00.000Z',
    quelle: 'lieferant',
    absender: 'buchhaltung@lieferant.example',
    dateiname: 'rechnung.pdf',
    pdfPfad: '/tmp/a.pdf',
  });
  const app = buildTestApp(db);

  const res = await request(app).get('/pool').set('x-test-person-id', '50');
  assert.equal(res.status, 200);
  assert.match(res.text, /Lieferant/);
  assert.match(res.text, /buchhaltung@lieferant\.example/);
  db.close();
});

test('GET /pool shows the Debitor (Lieferant) name in its own column, and an em dash when unset', async () => {
  const db = openDatabase(':memory:');
  seedBuchhaltungPerson(db);
  const zugewiesenId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'mit-debitor.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare("UPDATE jobs SET status = 'zugewiesen', zugewiesen_an = '50' WHERE id = ?").run(zugewiesenId);
  updateKontierungMetadaten(db, zugewiesenId, { absender: null, betrag: null, zahlungsziel: null, rechnungsnummer: null, lieferant: 'ACME Grosshandel', debitorId: null });
  createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'ohne-debitor.pdf', pdfPfad: '/tmp/b.pdf' });
  const app = buildTestApp(db);

  const res = await request(app).get('/pool').set('x-test-person-id', '50');
  assert.equal(res.status, 200);
  assert.match(res.text, /<th>Debitor<\/th>/);
  assert.match(res.text, /ACME Grosshandel/);
  db.close();
});

test('GET /pool shows an em dash for absender when n8n did not submit one', async () => {
  const db = openDatabase(':memory:');
  seedBuchhaltungPerson(db);
  createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'rechnung.pdf', pdfPfad: '/tmp/a.pdf' });
  const app = buildTestApp(db);

  const res = await request(app).get('/pool').set('x-test-person-id', '50');
  assert.equal(res.status, 200);
  assert.match(res.text, /Scanner/);
  assert.match(res.text, /—/);
  db.close();
});

test('GET /pool returns 200 for a logged-in person without the buchhaltung or portal-admin group, but hides the Pool section', async () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '77', vorname: 'Frei', nachname: 'Geber', email: 'a@example.org', gruppen: [], loggedInNow: true });
  const app = buildTestApp(db);
  const res = await request(app).get('/pool').set('x-test-person-id', '77');
  assert.equal(res.status, 200);
  assert.doesNotMatch(res.text, /<h2 class="h4 mt-4">Pool<\/h2>/);
  assert.match(res.text, /Meine offenen Kontierungen/);
  db.close();
});

test('GET /pool lists an unzugewiesen job in the Pool section with a thumbnail src and preview URL', async () => {
  const db = openDatabase(':memory:');
  seedBuchhaltungPerson(db);
  const id = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'rechnung.pdf', pdfPfad: '/tmp/a.pdf' });
  setThumbnailPfad(db, id, '/tmp/a-thumb.png');
  const app = buildTestApp(db);

  const res = await request(app).get('/pool').set('x-test-person-id', '50');
  assert.equal(res.status, 200);
  assert.match(res.text, new RegExp(`/api/pool/${id}/thumbnail`));
  // EJS's <%= %> HTML-escapes output, so the "&" between query params is rendered as "&amp;"
  // in the actual page source — this asserts the real escaped form, not the raw URL string.
  assert.match(res.text, /\/downloads\/\d+\?expires=\d+&amp;signature=[0-9a-f]{64}/);
  assert.match(res.text, new RegExp(`data-job-id="${id}"`));
  db.close();
});

test('GET /pool shows the fallback placeholder instead of an <img> for a job with no thumbnail', async () => {
  const db = openDatabase(':memory:');
  seedBuchhaltungPerson(db);
  const id = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'ohne-thumbnail.pdf', pdfPfad: '/tmp/a.pdf' });
  const app = buildTestApp(db);

  const res = await request(app).get('/pool').set('x-test-person-id', '50');
  assert.equal(res.status, 200);
  assert.match(res.text, /Keine Vorschau/);
  assert.doesNotMatch(res.text, new RegExp(`/api/pool/${id}/thumbnail`));
  db.close();
});

test('GET /pool lists a job assigned to the current person under "Meine offenen Kontierungen"', async () => {
  const db = openDatabase(':memory:');
  seedBuchhaltungPerson(db);
  const id = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'zu-kontieren.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, id, '50');
  const app = buildTestApp(db);

  const res = await request(app).get('/pool').set('x-test-person-id', '50');
  assert.equal(res.status, 200);
  assert.match(res.text, new RegExp(`/kontierung/${id}`));
  assert.match(res.text, new RegExp(`id="kontierung-row-${id}"`));
  assert.match(res.text, />Kontieren</);
  db.close();
});

test('GET /pool shows an "In den Pool legen" button next to Kontieren, posting to the existing zurueck-in-pool route', async () => {
  const db = openDatabase(':memory:');
  seedBuchhaltungPerson(db);
  const id = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'zu-kontieren.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, id, '50');
  const app = buildTestApp(db);

  const res = await request(app).get('/pool').set('x-test-person-id', '50');
  assert.equal(res.status, 200);
  assert.match(res.text, new RegExp(`action="/kontierung/${id}/zurueck-in-pool"`));
  assert.match(res.text, />In den Pool legen</);
  db.close();
});

test('GET /pool shows an em dash for Konto when a Pool job has not been kontiert yet', async () => {
  const db = openDatabase(':memory:');
  seedBuchhaltungPerson(db);
  createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'rechnung.pdf', pdfPfad: '/tmp/a.pdf' });
  const app = buildTestApp(db);

  const res = await request(app).get('/pool').set('x-test-person-id', '50');
  assert.equal(res.status, 200);
  assert.match(res.text, /<td>—<\/td>\s*<td>/);
  db.close();
});

test('GET /pool lists a job awaiting this person\'s Freigabe 2 under "Meine Freigaben"', async () => {
  const db = openDatabase(':memory:');
  seedBuchhaltungPerson(db, '50');
  for (const id of ['1', '2', '3']) {
    upsertPerson(db, { id, vorname: `Person${id}`, nachname: 'Muster', email: `p${id}@example.org`, gruppen: ['10'], loggedInNow: false });
  }
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '50', stellvertreter2Id: '3' });
  const id = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'freizugeben.pdf', pdfPfad: '/tmp/a.pdf' });
  setKontierung(db, id, kontoId);
  db.prepare("UPDATE jobs SET status = 'freigabe2' WHERE id = ?").run(id);
  const app = buildTestApp(db);

  const res = await request(app).get('/pool').set('x-test-person-id', '50');
  assert.equal(res.status, 200);
  assert.match(res.text, new RegExp(`/freigabe2/${id}`));
  assert.match(res.text, new RegExp(`id="freigabe2-row-${id}"`));
  assert.match(res.text, />Freigeben</);
  db.close();
});

test('GET /pool lists a job the current person can rework under "Meine abgelehnten Jobs"', async () => {
  const db = openDatabase(':memory:');
  seedBuchhaltungPerson(db, '50');
  for (const id of ['1', '2', '3']) {
    upsertPerson(db, { id, vorname: `Person${id}`, nachname: 'Muster', email: `p${id}@example.org`, gruppen: ['10'], loggedInNow: false });
  }
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '50', stellvertreter1Id: '1', freigeber2Id: '2', stellvertreter2Id: '3' });
  const id = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'abgelehnt.pdf', pdfPfad: '/tmp/a.pdf' });
  setKontierung(db, id, kontoId);
  db.prepare("UPDATE jobs SET status = 'freigabe2', zugewiesen_an = '50' WHERE id = ?").run(id);
  ablehnenJob(db, id, { abgelehntVon: '2', grund: 'Falsches Konto' });
  const app = buildTestApp(db);

  const res = await request(app).get('/pool').set('x-test-person-id', '50');
  assert.equal(res.status, 200);
  assert.match(res.text, new RegExp(`/abgelehnt/${id}`));
  assert.match(res.text, new RegExp(`id="abgelehnt-row-${id}"`));
  assert.match(res.text, />Ansehen</);
  db.close();
});

test('GET /pool re-fetches a fresh signed URL via /downloads/:jobId/refresh-url on thumbnail click, instead of only reusing the one baked in at render time', async () => {
  const db = openDatabase(':memory:');
  seedBuchhaltungPerson(db);
  const id = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'rechnung.pdf', pdfPfad: '/tmp/a.pdf' });
  setThumbnailPfad(db, id, '/tmp/a-thumb.png');
  const app = buildTestApp(db);
  const res = await request(app).get('/pool').set('x-test-person-id', '50');
  assert.equal(res.status, 200);
  assert.match(res.text, new RegExp(`data-job-id="${id}"`));
  assert.match(res.text, /fetch\(`\/downloads\/\$\{img\.dataset\.jobId\}\/refresh-url`\)/);
  db.close();
});

test('GET /pool wires the thumbnail preview through the PDF.js viewer, not the raw download URL', async () => {
  const db = openDatabase(':memory:');
  seedBuchhaltungPerson(db);
  const id = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'rechnung.pdf', pdfPfad: '/tmp/a.pdf' });
  setThumbnailPfad(db, id, '/tmp/a-thumb.png');
  const app = buildTestApp(db);

  const res = await request(app).get('/pool').set('x-test-person-id', '50');
  assert.equal(res.status, 200);
  assert.match(res.text, /new URL\(relativeUrl, window\.location\.origin\)\.href/);
  assert.match(res.text, /'\/vendor\/pdfjs\/web\/viewer\.html\?file=' \+ encodeURIComponent\(absoluteUrl\)/);
  db.close();
});

test('GET /pool renders the footer', async () => {
  const db = openDatabase(':memory:');
  seedBuchhaltungPerson(db);
  const app = buildTestApp(db);
  const res = await request(app).get('/pool').set('x-test-person-id', '50');
  assert.equal(res.status, 200);
  assert.match(res.text, /<footer/);
  db.close();
});

test('GET /pool shows the empty-state text when there are no abgelehnt jobs for this person', async () => {
  const db = openDatabase(':memory:');
  seedBuchhaltungPerson(db);
  const app = buildTestApp(db);
  const res = await request(app).get('/pool').set('x-test-person-id', '50');
  assert.equal(res.status, 200);
  assert.match(res.text, /Keine abgelehnten Rechnungen\./);
  db.close();
});
