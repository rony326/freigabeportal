import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createKonto } from '../../src/db/kontenRepo.js';
import { createJob, setKontierung, createSpesenPosition } from '../../src/db/jobsRepo.js';
import { createSpesenabrechnung } from '../../src/db/spesenabrechnungenRepo.js';
import { loadCurrentPerson, requireLogin } from '../../src/middleware/roles.js';
import { createZeitstempelPruefenRouter } from '../../src/routes/zeitstempelPruefen.js';
import { buildPdfFixture } from '../helpers/pdfFixture.js';

const RFC3161_TIMESTAMPED_PDF = readFileSync(new URL('../fixtures/rfc3161-timestamped.pdf', import.meta.url));

function buildTestApp(db, brandingOverrides = {}) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', new URL('../../views', import.meta.url).pathname);
  app.use((req, res, next) => {
    res.locals.branding = { primaryColor: '#000', secondaryColor: '#fff', hasLogo: false, themeAttr: null, seitenTitel: 'Freigabeportal', ...brandingOverrides };
    next();
  });
  app.use((req, res, next) => {
    req.session = { personId: req.headers['x-test-person-id'] };
    next();
  });
  const config = { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20' } };
  app.use(loadCurrentPerson(db));
  app.use('/zeitstempel-pruefen', requireLogin(), createZeitstempelPruefenRouter({ db, config }));
  return app;
}

function seedPerson(db, id = '1') {
  upsertPerson(db, { id, vorname: `Person${id}`, nachname: 'Muster', email: `p${id}@example.org`, gruppen: ['10'], loggedInNow: true });
}

test('GET /zeitstempel-pruefen returns 401 without a session', async () => {
  const db = openDatabase(':memory:');
  const app = buildTestApp(db);
  const res = await request(app).get('/zeitstempel-pruefen');
  assert.equal(res.status, 401);
  db.close();
});

test('GET /zeitstempel-pruefen shows the upload form for a logged-in person with no jobId', async () => {
  const db = openDatabase(':memory:');
  seedPerson(db);
  const app = buildTestApp(db);
  const res = await request(app).get('/zeitstempel-pruefen').set('x-test-person-id', '1');
  assert.equal(res.status, 200);
  assert.match(res.text, /<input type="file"[^>]*name="pdf"/);
  db.close();
});

test('POST /zeitstempel-pruefen with a PDF containing no timestamp reports it as not present', async () => {
  const db = openDatabase(':memory:');
  seedPerson(db);
  const app = buildTestApp(db);
  const plain = await buildPdfFixture(['Kein Zeitstempel hier.']);
  const res = await request(app)
    .post('/zeitstempel-pruefen')
    .set('x-test-person-id', '1')
    .attach('pdf', plain, 'plain.pdf');
  assert.equal(res.status, 200);
  assert.match(res.text, /Kein Zeitstempel in dieser Datei gefunden/);
  db.close();
});

test('POST /zeitstempel-pruefen with a validly timestamped PDF reports it as valid, with the timestamp', async () => {
  const db = openDatabase(':memory:');
  seedPerson(db);
  const app = buildTestApp(db);
  const res = await request(app)
    .post('/zeitstempel-pruefen')
    .set('x-test-person-id', '1')
    .attach('pdf', RFC3161_TIMESTAMPED_PDF, 'timestamped.pdf');
  assert.equal(res.status, 200);
  assert.match(res.text, /Kryptografisch gültig \(RFC3161\)/);
  assert.match(res.text, /Diese Datei ist nachweislich unverändert/);
  assert.match(res.text, /2026-08-21T07:21:19\.000Z/);
  assert.match(res.text, /kein Vergleichswert vorhanden/);
  db.close();
});

test('POST /zeitstempel-pruefen without a file attached is rejected with a clear error', async () => {
  const db = openDatabase(':memory:');
  seedPerson(db);
  const app = buildTestApp(db);
  const res = await request(app).post('/zeitstempel-pruefen').set('x-test-person-id', '1');
  assert.equal(res.status, 400);
  assert.match(res.text, /Bitte eine PDF-Datei auswählen/);
  db.close();
});

test('POST /zeitstempel-pruefen with a jobId compares the upload against that job\'s stored hash — match', async () => {
  const { createHash } = await import('node:crypto');
  const db = openDatabase(':memory:');
  seedPerson(db, '1');
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '1', freigeber2Id: '1', stellvertreter2Id: '1' });
  const id = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  setKontierung(db, id, kontoId);
  const hash = createHash('sha256').update(RFC3161_TIMESTAMPED_PDF).digest('hex');
  db.prepare("UPDATE jobs SET status = 'abgeschlossen', zugewiesen_an = '1', zeitstempel_datei_hash = ? WHERE id = ?").run(hash, id);

  const app = buildTestApp(db);
  const res = await request(app)
    .post('/zeitstempel-pruefen')
    .set('x-test-person-id', '1')
    .field('jobId', String(id))
    .attach('pdf', RFC3161_TIMESTAMPED_PDF, 'timestamped.pdf');
  assert.equal(res.status, 200);
  assert.match(res.text, /Hash stimmt mit Datenbank überein/);
  assert.match(res.text, /stimmt nachweislich mit der im Portal archivierten Originaldatei überein/, 'a confirmed match must be stated positively, not hedged, for non-technical readers');
  db.close();
});

test('POST /zeitstempel-pruefen with a jobId compares the upload against that job\'s stored hash — mismatch', async () => {
  const db = openDatabase(':memory:');
  seedPerson(db, '1');
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '1', freigeber2Id: '1', stellvertreter2Id: '1' });
  const id = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  setKontierung(db, id, kontoId);
  db.prepare("UPDATE jobs SET status = 'abgeschlossen', zugewiesen_an = '1', zeitstempel_datei_hash = 'ein-anderer-hash' WHERE id = ?").run(id);

  const app = buildTestApp(db);
  const res = await request(app)
    .post('/zeitstempel-pruefen')
    .set('x-test-person-id', '1')
    .field('jobId', String(id))
    .attach('pdf', RFC3161_TIMESTAMPED_PDF, 'timestamped.pdf');
  assert.equal(res.status, 200);
  assert.match(res.text, /Hash weicht von der Datenbank ab/);
  assert.match(res.text, /weicht von der im Portal archivierten Originaldatei ab/, 'a confirmed mismatch must be stated clearly, not just implied by the checklist symbol');
  db.close();
});

test('POST /zeitstempel-pruefen with a jobId for a job with no stored hash states plainly that no comparison was possible', async () => {
  const db = openDatabase(':memory:');
  seedPerson(db, '1');
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '1', freigeber2Id: '1', stellvertreter2Id: '1' });
  const id = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  setKontierung(db, id, kontoId);
  db.prepare("UPDATE jobs SET status = 'abgeschlossen', zugewiesen_an = '1' WHERE id = ?").run(id);

  const app = buildTestApp(db);
  const res = await request(app)
    .post('/zeitstempel-pruefen')
    .set('x-test-person-id', '1')
    .field('jobId', String(id))
    .attach('pdf', RFC3161_TIMESTAMPED_PDF, 'timestamped.pdf');
  assert.equal(res.status, 200);
  assert.match(res.text, /kein Vergleichswert im Portal hinterlegt/);
  db.close();
});

test('POST /zeitstempel-pruefen with a jobId for a job the person is not authorized to view returns 403', async () => {
  const db = openDatabase(':memory:');
  seedPerson(db, '1');
  seedPerson(db, '2');
  seedPerson(db, '3');
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '1', freigeber2Id: '3', stellvertreter2Id: '3' });
  const id = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  setKontierung(db, id, kontoId);
  db.prepare("UPDATE jobs SET status = 'abgeschlossen', zugewiesen_an = '1' WHERE id = ?").run(id);

  const app = buildTestApp(db);
  const res = await request(app)
    .post('/zeitstempel-pruefen')
    .set('x-test-person-id', '2')
    .field('jobId', String(id))
    .attach('pdf', RFC3161_TIMESTAMPED_PDF, 'timestamped.pdf');
  assert.equal(res.status, 403);
  db.close();
});

test('POST /zeitstempel-pruefen with a jobId renders the Prüfbescheinigung directly, noting the checked file was uploaded (not read from the portal)', async () => {
  const { createHash } = await import('node:crypto');
  const db = openDatabase(':memory:');
  seedPerson(db, '1');
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '1', freigeber2Id: '1', stellvertreter2Id: '1' });
  const id = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  setKontierung(db, id, kontoId);
  const hash = createHash('sha256').update(RFC3161_TIMESTAMPED_PDF).digest('hex');
  db.prepare("UPDATE jobs SET status = 'abgeschlossen', zugewiesen_an = '1', zeitstempel_datei_hash = ?, rechnungsnummer = 'RE-2026-042' WHERE id = ?").run(hash, id);

  const app = buildTestApp(db);
  const res = await request(app)
    .post('/zeitstempel-pruefen')
    .set('x-test-person-id', '1')
    .field('jobId', String(id))
    .attach('pdf', RFC3161_TIMESTAMPED_PDF, 'timestamped.pdf');
  assert.equal(res.status, 200);
  assert.match(res.text, /Prüfbescheinigung/);
  assert.match(res.text, /RE-2026-042/);
  assert.match(res.text, /stimmt nachweislich mit der im Portal archivierten Originaldatei überein/);
  assert.match(res.text, /window\.print\(\)/);
  db.close();
});

test('GET /zeitstempel-pruefen?jobId= verifies the job\'s own PDF directly for an authorized person, no upload form', async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const db = openDatabase(':memory:');
  seedPerson(db, '1');
  seedPerson(db, '3');
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '1', freigeber2Id: '3', stellvertreter2Id: '3' });
  const dir = mkdtempSync(join(tmpdir(), 'zeitstempel-pruefen-test-'));
  const pdfPfad = join(dir, 'a.pdf');
  writeFileSync(pdfPfad, RFC3161_TIMESTAMPED_PDF);
  const id = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad });
  setKontierung(db, id, kontoId);
  db.prepare("UPDATE jobs SET status = 'abgeschlossen', zugewiesen_an = '1' WHERE id = ?").run(id);

  const app = buildTestApp(db);
  const res = await request(app).get(`/zeitstempel-pruefen?jobId=${id}`).set('x-test-person-id', '1');
  assert.equal(res.status, 200);
  assert.match(res.text, /Kryptografisch gültig \(RFC3161\)/);
  assert.match(res.text, /Diese Datei ist nachweislich unverändert/);
  assert.doesNotMatch(res.text, /<input type="file"/);

  rmSync(dir, { recursive: true, force: true });
  db.close();
});

test('GET /zeitstempel-pruefen?jobId= shows a matching hash for an unaltered file', async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createHash } = await import('node:crypto');
  const db = openDatabase(':memory:');
  seedPerson(db, '1');
  seedPerson(db, '3');
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '1', freigeber2Id: '3', stellvertreter2Id: '3' });
  const dir = mkdtempSync(join(tmpdir(), 'zeitstempel-pruefen-hash-test-'));
  const pdfPfad = join(dir, 'a.pdf');
  writeFileSync(pdfPfad, RFC3161_TIMESTAMPED_PDF);
  const id = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad });
  setKontierung(db, id, kontoId);
  const hash = createHash('sha256').update(RFC3161_TIMESTAMPED_PDF).digest('hex');
  db.prepare("UPDATE jobs SET status = 'abgeschlossen', zugewiesen_an = '1', zeitstempel_datei_hash = ? WHERE id = ?").run(hash, id);

  const app = buildTestApp(db);
  const res = await request(app).get(`/zeitstempel-pruefen?jobId=${id}`).set('x-test-person-id', '1');
  assert.equal(res.status, 200);
  assert.match(res.text, /Hash stimmt mit Datenbank überein/);
  assert.match(res.text, /Zertifikat anzeigen/);

  rmSync(dir, { recursive: true, force: true });
  db.close();
});

test('GET /zeitstempel-pruefen?jobId= shows a mismatched hash and a red banner when the file was swapped after stamping', async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const db = openDatabase(':memory:');
  seedPerson(db, '1');
  seedPerson(db, '3');
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '1', freigeber2Id: '3', stellvertreter2Id: '3' });
  const dir = mkdtempSync(join(tmpdir(), 'zeitstempel-pruefen-hash-mismatch-test-'));
  const pdfPfad = join(dir, 'a.pdf');
  writeFileSync(pdfPfad, RFC3161_TIMESTAMPED_PDF);
  const id = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad });
  setKontierung(db, id, kontoId);
  db.prepare("UPDATE jobs SET status = 'abgeschlossen', zugewiesen_an = '1', zeitstempel_datei_hash = 'ein-anderer-hash' WHERE id = ?").run(id);

  const app = buildTestApp(db);
  const res = await request(app).get(`/zeitstempel-pruefen?jobId=${id}`).set('x-test-person-id', '1');
  assert.equal(res.status, 200);
  assert.match(res.text, /Datei weicht vom in der Datenbank hinterlegten Original ab/);

  rmSync(dir, { recursive: true, force: true });
  db.close();
});

test('GET /zeitstempel-pruefen?jobId= shows the hash mismatch even when the file has no timestamp at all', async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const db = openDatabase(':memory:');
  seedPerson(db, '1');
  seedPerson(db, '3');
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '1', freigeber2Id: '3', stellvertreter2Id: '3' });
  const dir = mkdtempSync(join(tmpdir(), 'zeitstempel-pruefen-mismatch-untimestamped-test-'));
  const pdfPfad = join(dir, 'a.pdf');
  const unstamped = await buildPdfFixture(['Kein Zeitstempel hier.']);
  writeFileSync(pdfPfad, unstamped);
  const id = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad });
  setKontierung(db, id, kontoId);
  db.prepare("UPDATE jobs SET status = 'abgeschlossen', zugewiesen_an = '1', zeitstempel_datei_hash = 'ein-anderer-hash' WHERE id = ?").run(id);

  const app = buildTestApp(db);
  const res = await request(app).get(`/zeitstempel-pruefen?jobId=${id}`).set('x-test-person-id', '1');
  assert.equal(res.status, 200);
  assert.match(res.text, /Kein Zeitstempel in dieser Datei gefunden/);
  assert.match(res.text, /Hash weicht von der Datenbank ab/);

  rmSync(dir, { recursive: true, force: true });
  db.close();
});

test('GET /zeitstempel-pruefen?jobId= shows "kein Vergleichswert" for a job with no stored hash', async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const db = openDatabase(':memory:');
  seedPerson(db, '1');
  seedPerson(db, '3');
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '1', freigeber2Id: '3', stellvertreter2Id: '3' });
  const dir = mkdtempSync(join(tmpdir(), 'zeitstempel-pruefen-hash-none-test-'));
  const pdfPfad = join(dir, 'a.pdf');
  writeFileSync(pdfPfad, RFC3161_TIMESTAMPED_PDF);
  const id = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad });
  setKontierung(db, id, kontoId);
  db.prepare("UPDATE jobs SET status = 'abgeschlossen', zugewiesen_an = '1' WHERE id = ?").run(id);

  const app = buildTestApp(db);
  const res = await request(app).get(`/zeitstempel-pruefen?jobId=${id}`).set('x-test-person-id', '1');
  assert.equal(res.status, 200);
  assert.match(res.text, /kein Vergleichswert vorhanden/);

  rmSync(dir, { recursive: true, force: true });
  db.close();
});

test('GET /zeitstempel-pruefen?jobId= lets a Spesen position\'s own submitter verify it, even though they are neither zugewiesen_an nor Freigeber2/Stellvertreter2', async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const db = openDatabase(':memory:');
  seedPerson(db, '1'); // Freigeber1/zugewiesen_an
  seedPerson(db, '3'); // Freigeber2
  seedPerson(db, '4'); // Einreicher — no other role on this Konto at all
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '1', freigeber2Id: '3', stellvertreter2Id: '3' });
  const dir = mkdtempSync(join(tmpdir(), 'zeitstempel-pruefen-spesen-einreicher-test-'));
  const pdfPfad = join(dir, 'beleg.pdf');
  writeFileSync(pdfPfad, RFC3161_TIMESTAMPED_PDF);
  const spesenabrechnungId = createSpesenabrechnung(db, { eingereichtVon: '4', eingereichtAm: '2026-08-31T08:00:00.000Z', titel: null });
  const id = createSpesenPosition(db, {
    eingangAm: '2026-08-31T08:00:00.000Z', eingereichtVon: '4', kontoId, betrag: '10.00', auslageDatum: '2026-08-20',
    beschreibung: 'Taxi', dateiname: 'beleg.pdf', pdfPfad, thumbnailPfad: null, spesenabrechnungId,
    zugewiesenAn: '1', freigabe1EskaliertVon: null, freigabe1Eskalationsgrund: null,
  });
  db.prepare("UPDATE jobs SET status = 'abgeschlossen' WHERE id = ?").run(id);

  const app = buildTestApp(db);
  const res = await request(app).get(`/zeitstempel-pruefen?jobId=${id}`).set('x-test-person-id', '4');
  assert.equal(res.status, 200);
  assert.match(res.text, /Kryptografisch gültig \(RFC3161\)/);

  rmSync(dir, { recursive: true, force: true });
  db.close();
});

test('GET /zeitstempel-pruefen?jobId= returns 403 for a person not authorized to view that job', async () => {
  const db = openDatabase(':memory:');
  seedPerson(db, '1');
  seedPerson(db, '2');
  seedPerson(db, '3');
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '1', freigeber2Id: '3', stellvertreter2Id: '3' });
  const id = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  setKontierung(db, id, kontoId);
  db.prepare("UPDATE jobs SET status = 'abgeschlossen', zugewiesen_an = '1' WHERE id = ?").run(id);

  const app = buildTestApp(db);
  const res = await request(app).get(`/zeitstempel-pruefen?jobId=${id}`).set('x-test-person-id', '2');
  assert.equal(res.status, 403);
  db.close();
});

test('GET /zeitstempel-pruefen?jobId= returns 404 when the job\'s PDF file no longer exists', async () => {
  const db = openDatabase(':memory:');
  seedPerson(db, '1');
  seedPerson(db, '3');
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '1', freigeber2Id: '3', stellvertreter2Id: '3' });
  const id = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/nonexistent/gone.pdf' });
  setKontierung(db, id, kontoId);
  db.prepare("UPDATE jobs SET status = 'abgeholt', zugewiesen_an = '1' WHERE id = ?").run(id);

  const app = buildTestApp(db);
  const res = await request(app).get(`/zeitstempel-pruefen?jobId=${id}`).set('x-test-person-id', '1');
  assert.equal(res.status, 404);
  db.close();
});

test('GET /zeitstempel-pruefen/zertifikat?jobId= returns 401 without a session', async () => {
  const db = openDatabase(':memory:');
  const app = buildTestApp(db);
  const res = await request(app).get('/zeitstempel-pruefen/zertifikat?jobId=1');
  assert.equal(res.status, 401);
  db.close();
});

test('GET /zeitstempel-pruefen/zertifikat?jobId= returns 403 for a person not authorized to view that job', async () => {
  const db = openDatabase(':memory:');
  seedPerson(db, '1');
  seedPerson(db, '2');
  seedPerson(db, '3');
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '1', freigeber2Id: '3', stellvertreter2Id: '3' });
  const id = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  setKontierung(db, id, kontoId);
  db.prepare("UPDATE jobs SET status = 'abgeschlossen', zugewiesen_an = '1' WHERE id = ?").run(id);

  const app = buildTestApp(db);
  const res = await request(app).get(`/zeitstempel-pruefen/zertifikat?jobId=${id}`).set('x-test-person-id', '2');
  assert.equal(res.status, 403);
  db.close();
});

test('GET /zeitstempel-pruefen/zertifikat?jobId= returns 404 when the job\'s PDF file no longer exists', async () => {
  const db = openDatabase(':memory:');
  seedPerson(db, '1');
  seedPerson(db, '3');
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '1', freigeber2Id: '3', stellvertreter2Id: '3' });
  const id = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/nonexistent/gone.pdf' });
  setKontierung(db, id, kontoId);
  db.prepare("UPDATE jobs SET status = 'abgeholt', zugewiesen_an = '1' WHERE id = ?").run(id);

  const app = buildTestApp(db);
  const res = await request(app).get(`/zeitstempel-pruefen/zertifikat?jobId=${id}`).set('x-test-person-id', '1');
  assert.equal(res.status, 404);
  db.close();
});

test('GET /zeitstempel-pruefen/zertifikat?jobId= renders the Prüfbescheinigung with job context and hash values', async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createHash } = await import('node:crypto');
  const db = openDatabase(':memory:');
  seedPerson(db, '1');
  seedPerson(db, '3');
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '1', freigeber2Id: '3', stellvertreter2Id: '3' });
  const dir = mkdtempSync(join(tmpdir(), 'zeitstempel-zertifikat-test-'));
  const pdfPfad = join(dir, 'a.pdf');
  writeFileSync(pdfPfad, RFC3161_TIMESTAMPED_PDF);
  const hash = createHash('sha256').update(RFC3161_TIMESTAMPED_PDF).digest('hex');
  const id = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad });
  setKontierung(db, id, kontoId);
  db.prepare("UPDATE jobs SET status = 'abgeschlossen', zugewiesen_an = '1', zeitstempel_datei_hash = ?, rechnungsnummer = 'RE-2026-042', lieferant = 'Muster AG', betrag = '123.45' WHERE id = ?").run(hash, id);

  const app = buildTestApp(db);
  const res = await request(app).get(`/zeitstempel-pruefen/zertifikat?jobId=${id}`).set('x-test-person-id', '1');
  assert.equal(res.status, 200);
  assert.match(res.text, /Prüfbescheinigung/);
  assert.match(res.text, /RE-2026-042/);
  assert.match(res.text, /Muster AG/);
  assert.match(res.text, new RegExp(hash));
  assert.match(res.text, /window\.print\(\)/);
  assert.doesNotMatch(res.text, /<img src="\/branding\/logo"/, 'no logo configured for this test app — must not render a broken/empty logo tag');

  rmSync(dir, { recursive: true, force: true });
  db.close();
});

test('GET /zeitstempel-pruefen/zertifikat?jobId= shows the branding logo and Organisationsname when configured', async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createHash } = await import('node:crypto');
  const db = openDatabase(':memory:');
  seedPerson(db, '1');
  seedPerson(db, '3');
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '1', freigeber2Id: '3', stellvertreter2Id: '3' });
  const dir = mkdtempSync(join(tmpdir(), 'zeitstempel-zertifikat-branding-test-'));
  const pdfPfad = join(dir, 'a.pdf');
  writeFileSync(pdfPfad, RFC3161_TIMESTAMPED_PDF);
  const hash = createHash('sha256').update(RFC3161_TIMESTAMPED_PDF).digest('hex');
  const id = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad });
  setKontierung(db, id, kontoId);
  db.prepare("UPDATE jobs SET status = 'abgeschlossen', zugewiesen_an = '1', zeitstempel_datei_hash = ? WHERE id = ?").run(hash, id);

  const app = buildTestApp(db, { hasLogo: true, seitenTitel: 'Muster-Gemeinde' });
  const res = await request(app).get(`/zeitstempel-pruefen/zertifikat?jobId=${id}`).set('x-test-person-id', '1');
  assert.equal(res.status, 200);
  assert.match(res.text, /<img src="\/branding\/logo"/);
  assert.match(res.text, /Muster-Gemeinde/);

  rmSync(dir, { recursive: true, force: true });
  db.close();
});
