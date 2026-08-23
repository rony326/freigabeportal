import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase } from '../../../src/db/index.js';
import { createJob, getJobById, setThumbnailPfad, updateKontierungMetadaten } from '../../../src/db/jobsRepo.js';
import { requireApiKey } from '../../../src/middleware/apiKey.js';
import { createN8nJobsRouter } from '../../../src/routes/n8n/jobs.js';
import { buildPdfFixture } from '../../helpers/pdfFixture.js';
import { setConfigValue } from '../../../src/db/adminConfigRepo.js';

const PDF_BYTES = Buffer.from('%PDF-1.4\n%test-fixture-not-a-real-pdf-body\n');

function buildTestApp(db, config, mailer) {
  const app = express();
  app.use('/api/n8n/jobs', requireApiKey(config), createN8nJobsRouter({ db, config, mailer }));
  return app;
}

function createStubMailer() {
  const sent = [];
  return { sent, async sendMail(mail) { sent.push(mail); } };
}

function testConfig(jobsDir) {
  return { n8nApiKey: 'n8n-key', jobsDir, downloadSigningSecret: 'test-secret' };
}

test('POST /api/n8n/jobs without a valid API key returns 401 and creates nothing', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const db = openDatabase(':memory:');
  const jobsDir = mkdtempSync(join(tmpdir(), 'jobs-test-'));
  const app = buildTestApp(db, testConfig(jobsDir), createStubMailer());

  const res = await request(app)
    .post('/api/n8n/jobs')
    .field('quelle', 'scanner')
    .field('dateiname', 'scan.pdf')
    .attach('pdf', PDF_BYTES, { filename: 'scan.pdf', contentType: 'application/pdf' });

  assert.equal(res.status, 401);
  db.close();
});

test('POST /api/n8n/jobs with a valid PDF and API key creates a job', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const db = openDatabase(':memory:');
  const jobsDir = mkdtempSync(join(tmpdir(), 'jobs-test-'));
  const app = buildTestApp(db, testConfig(jobsDir), createStubMailer());

  const res = await request(app)
    .post('/api/n8n/jobs')
    .set('X-API-Key', 'n8n-key')
    .field('quelle', 'scanner')
    .field('dateiname', 'scan.pdf')
    .attach('pdf', PDF_BYTES, { filename: 'scan.pdf', contentType: 'application/pdf' });

  assert.equal(res.status, 201);
  assert.equal(res.body.status, 'unzugewiesen');
  const job = getJobById(db, res.body.id);
  assert.equal(job.dateiname, 'scan.pdf');
  assert.equal(job.quelle, 'scanner');
  db.close();
  rmSync(jobsDir, { recursive: true, force: true });
});

test('POST /api/n8n/jobs submitting the exact same PDF bytes twice returns the original job instead of creating a duplicate', async () => {
  const { mkdtempSync, rmSync, readdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const db = openDatabase(':memory:');
  const jobsDir = mkdtempSync(join(tmpdir(), 'jobs-test-'));
  const app = buildTestApp(db, testConfig(jobsDir), createStubMailer());

  const first = await request(app)
    .post('/api/n8n/jobs')
    .set('X-API-Key', 'n8n-key')
    .field('quelle', 'scanner')
    .field('dateiname', 'scan.pdf')
    .attach('pdf', PDF_BYTES, { filename: 'scan.pdf', contentType: 'application/pdf' });
  assert.equal(first.status, 201);

  const retry = await request(app)
    .post('/api/n8n/jobs')
    .set('X-API-Key', 'n8n-key')
    .field('quelle', 'scanner')
    .field('dateiname', 'scan.pdf')
    .attach('pdf', PDF_BYTES, { filename: 'scan.pdf', contentType: 'application/pdf' });

  assert.equal(retry.status, 200);
  assert.equal(retry.body.id, first.body.id);
  assert.equal(retry.body.duplikat, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n, 1, 'no second job row should have been created');
  assert.equal(readdirSync(jobsDir).length, 1, 'no second PDF file should have been written to disk');
  db.close();
  rmSync(jobsDir, { recursive: true, force: true });
});

test('POST /api/n8n/jobs with different PDF bytes (even with identical metadata) creates a separate job', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const db = openDatabase(':memory:');
  const jobsDir = mkdtempSync(join(tmpdir(), 'jobs-test-'));
  const app = buildTestApp(db, testConfig(jobsDir), createStubMailer());

  const first = await request(app)
    .post('/api/n8n/jobs')
    .set('X-API-Key', 'n8n-key')
    .field('quelle', 'scanner')
    .field('dateiname', 'scan.pdf')
    .attach('pdf', PDF_BYTES, { filename: 'scan.pdf', contentType: 'application/pdf' });

  const second = await request(app)
    .post('/api/n8n/jobs')
    .set('X-API-Key', 'n8n-key')
    .field('quelle', 'scanner')
    .field('dateiname', 'scan.pdf')
    .attach('pdf', Buffer.from('%PDF-1.4\n%ein-anderes-dokument\n'), { filename: 'scan.pdf', contentType: 'application/pdf' });

  assert.equal(second.status, 201);
  assert.notEqual(second.body.id, first.body.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n, 2);
  db.close();
  rmSync(jobsDir, { recursive: true, force: true });
});

test('POST /api/n8n/jobs stores a valid eingang_am, normalized to ISO', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const db = openDatabase(':memory:');
  const jobsDir = mkdtempSync(join(tmpdir(), 'jobs-test-'));
  const app = buildTestApp(db, testConfig(jobsDir), createStubMailer());

  const res = await request(app)
    .post('/api/n8n/jobs')
    .set('X-API-Key', 'n8n-key')
    .field('quelle', 'scanner')
    .field('dateiname', 'scan.pdf')
    .field('eingang_am', '2026-08-15T08:00:00.000Z')
    .attach('pdf', PDF_BYTES, { filename: 'scan.pdf', contentType: 'application/pdf' });

  assert.equal(res.status, 201);
  const job = getJobById(db, res.body.id);
  assert.equal(job.eingang_am, '2026-08-15T08:00:00.000Z');
  db.close();
  rmSync(jobsDir, { recursive: true, force: true });
});

test('POST /api/n8n/jobs rejects a malformed eingang_am, creates nothing', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const db = openDatabase(':memory:');
  const jobsDir = mkdtempSync(join(tmpdir(), 'jobs-test-'));
  const app = buildTestApp(db, testConfig(jobsDir), createStubMailer());

  const res = await request(app)
    .post('/api/n8n/jobs')
    .set('X-API-Key', 'n8n-key')
    .field('quelle', 'scanner')
    .field('dateiname', 'scan.pdf')
    .field('eingang_am', 'nicht-ein-datum')
    .attach('pdf', PDF_BYTES, { filename: 'scan.pdf', contentType: 'application/pdf' });

  assert.equal(res.status, 400);
  assert.match(res.body.error, /eingang_am/);
  db.close();
  rmSync(jobsDir, { recursive: true, force: true });
});

test('POST /api/n8n/jobs rejects a file that is not a real PDF, creates nothing', async () => {
  const { mkdtempSync, readdirSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const db = openDatabase(':memory:');
  const jobsDir = mkdtempSync(join(tmpdir(), 'jobs-test-'));
  const app = buildTestApp(db, testConfig(jobsDir), createStubMailer());

  const res = await request(app)
    .post('/api/n8n/jobs')
    .set('X-API-Key', 'n8n-key')
    .field('quelle', 'scanner')
    .field('dateiname', 'fake.pdf')
    .attach('pdf', Buffer.from('not a pdf'), { filename: 'fake.pdf', contentType: 'application/pdf' });

  assert.equal(res.status, 400);
  assert.equal(readdirSync(jobsDir).length, 0);
  db.close();
  rmSync(jobsDir, { recursive: true, force: true });
});

test('POST /api/n8n/jobs rejects an invalid quelle value', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const db = openDatabase(':memory:');
  const jobsDir = mkdtempSync(join(tmpdir(), 'jobs-test-'));
  const app = buildTestApp(db, testConfig(jobsDir), createStubMailer());

  const res = await request(app)
    .post('/api/n8n/jobs')
    .set('X-API-Key', 'n8n-key')
    .field('quelle', 'irgendwas')
    .field('dateiname', 'scan.pdf')
    .attach('pdf', PDF_BYTES, { filename: 'scan.pdf', contentType: 'application/pdf' });

  assert.equal(res.status, 400);
  db.close();
});

test('POST /api/n8n/jobs rejects a PDF larger than 20 MB, creates nothing', async () => {
  const { mkdtempSync, readdirSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const db = openDatabase(':memory:');
  const jobsDir = mkdtempSync(join(tmpdir(), 'jobs-test-'));
  const app = buildTestApp(db, testConfig(jobsDir), createStubMailer());

  const oversized = Buffer.alloc(20 * 1024 * 1024 + 1, 0x25);

  const res = await request(app)
    .post('/api/n8n/jobs')
    .set('X-API-Key', 'n8n-key')
    .field('quelle', 'scanner')
    .field('dateiname', 'huge.pdf')
    .attach('pdf', oversized, { filename: 'huge.pdf', contentType: 'application/pdf' });

  assert.equal(res.status, 400);
  assert.match(res.body.error, /20 MB/);
  assert.equal(readdirSync(jobsDir).length, 0);
  db.close();
  rmSync(jobsDir, { recursive: true, force: true });
});

test('POST /api/n8n/jobs rejects a request missing dateiname, creates nothing', async () => {
  const { mkdtempSync, readdirSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const db = openDatabase(':memory:');
  const jobsDir = mkdtempSync(join(tmpdir(), 'jobs-test-'));
  const app = buildTestApp(db, testConfig(jobsDir), createStubMailer());

  const res = await request(app)
    .post('/api/n8n/jobs')
    .set('X-API-Key', 'n8n-key')
    .field('quelle', 'scanner')
    .attach('pdf', PDF_BYTES, { filename: 'scan.pdf', contentType: 'application/pdf' });

  assert.equal(res.status, 400);
  assert.equal(readdirSync(jobsDir).length, 0);
  db.close();
  rmSync(jobsDir, { recursive: true, force: true });
});

test('POST /api/n8n/jobs applies Zuweisungsregel matching and reports the resulting status', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { upsertPerson } = await import('../../../src/db/personenRepo.js');
  const { createKonto } = await import('../../../src/db/kontenRepo.js');
  const { createDebitor } = await import('../../../src/db/debitorenRepo.js');
  const { createZuweisungsregel } = await import('../../../src/db/zuweisungsregelnRepo.js');

  const db = openDatabase(':memory:');
  for (const id of ['1', '2', '3', '4']) {
    upsertPerson(db, { id, vorname: `Person${id}`, nachname: 'Muster', email: `p${id}@example.org`, gruppen: ['10'], loggedInNow: false });
  }
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  const debitorId = createDebitor(db, { name: 'Muster AG', kontoId });
  createZuweisungsregel(db, { absenderMuster: 'lieferant.ch', debitorId });

  const jobsDir = mkdtempSync(join(tmpdir(), 'jobs-test-'));
  const app = buildTestApp(db, testConfig(jobsDir), createStubMailer());

  const res = await request(app)
    .post('/api/n8n/jobs')
    .set('X-API-Key', 'n8n-key')
    .field('quelle', 'lieferant')
    .field('absender', 'rechnungen@lieferant.ch')
    .field('dateiname', 'rechnung.pdf')
    .attach('pdf', PDF_BYTES, { filename: 'rechnung.pdf', contentType: 'application/pdf' });

  assert.equal(res.status, 201);
  assert.equal(res.body.status, 'zugewiesen');
  db.close();
  rmSync(jobsDir, { recursive: true, force: true });
});

function seedAbgeschlossenJobWithFile(db, jobsDir) {
  const pdfPfad = join(jobsDir, `seed-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);
  writeFileSync(pdfPfad, PDF_BYTES);
  const id = createJob(db, { eingangAm: '2026-08-14T10:00:00.000Z', quelle: 'lieferant', absender: null, dateiname: 'a.pdf', pdfPfad });
  db.prepare("UPDATE jobs SET status = 'abgeschlossen' WHERE id = ?").run(id);
  return { id, pdfPfad };
}

test('POST /api/n8n/jobs/:id/abholung-bestaetigen without a valid API key returns 401', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const db = openDatabase(':memory:');
  const jobsDir = mkdtempSync(join(tmpdir(), 'jobs-test-'));
  const app = buildTestApp(db, testConfig(jobsDir), createStubMailer());
  const res = await request(app).post('/api/n8n/jobs/1/abholung-bestaetigen');
  assert.equal(res.status, 401);
  db.close();
});

test('GET /api/n8n/jobs/abholbereit without a valid API key returns 401', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const db = openDatabase(':memory:');
  const jobsDir = mkdtempSync(join(tmpdir(), 'jobs-test-'));
  const app = buildTestApp(db, testConfig(jobsDir), createStubMailer());
  const res = await request(app).get('/api/n8n/jobs/abholbereit');
  assert.equal(res.status, 401);
  db.close();
});

test('GET /api/n8n/jobs/abholbereit returns an abgeschlossen job with a signed download URL, then omits it on an immediate second call', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const db = openDatabase(':memory:');
  const jobsDir = mkdtempSync(join(tmpdir(), 'jobs-test-'));
  const app = buildTestApp(db, testConfig(jobsDir), createStubMailer());

  const { id } = seedAbgeschlossenJobWithFile(db, jobsDir);

  const firstRes = await request(app).get('/api/n8n/jobs/abholbereit').set('X-API-Key', 'n8n-key');
  assert.equal(firstRes.status, 200);
  assert.equal(firstRes.body.length, 1);
  assert.equal(firstRes.body[0].id, id);
  assert.match(firstRes.body[0].download_url, /^\/downloads\/\d+\?expires=\d+&signature=[0-9a-f]{64}$/);

  const secondRes = await request(app).get('/api/n8n/jobs/abholbereit').set('X-API-Key', 'n8n-key');
  assert.equal(secondRes.body.length, 0);

  db.close();
  rmSync(jobsDir, { recursive: true, force: true });
});

test('GET /api/n8n/jobs/abholbereit omits an abgeschlossen job without a Zeitstempel while a TSA is configured', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const db = openDatabase(':memory:');
  const jobsDir = mkdtempSync(join(tmpdir(), 'jobs-test-'));
  const app = buildTestApp(db, testConfig(jobsDir), createStubMailer());
  setConfigValue(db, 'zeitstempel_tsa_url', 'https://tsa.example.org/tsr');

  seedAbgeschlossenJobWithFile(db, jobsDir);

  const res = await request(app).get('/api/n8n/jobs/abholbereit').set('X-API-Key', 'n8n-key');
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 0);

  db.close();
  rmSync(jobsDir, { recursive: true, force: true });
});

test('GET /api/n8n/jobs/abholbereit lists an abgeschlossen job once it has a Zeitstempel, while a TSA is configured', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const db = openDatabase(':memory:');
  const jobsDir = mkdtempSync(join(tmpdir(), 'jobs-test-'));
  const app = buildTestApp(db, testConfig(jobsDir), createStubMailer());
  setConfigValue(db, 'zeitstempel_tsa_url', 'https://tsa.example.org/tsr');

  const { id } = seedAbgeschlossenJobWithFile(db, jobsDir);
  db.prepare('UPDATE jobs SET zeitstempel_gesetzt_am = ? WHERE id = ?').run('2026-08-21T09:00:00.000Z', id);

  const res = await request(app).get('/api/n8n/jobs/abholbereit').set('X-API-Key', 'n8n-key');
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].id, id);

  db.close();
  rmSync(jobsDir, { recursive: true, force: true });
});

test('GET /api/n8n/jobs/abholbereit includes lieferant, rechnungsnummer, betrag and zahlungsziel for downstream Paperless/Bexio handoff', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const db = openDatabase(':memory:');
  const jobsDir = mkdtempSync(join(tmpdir(), 'jobs-test-'));
  const app = buildTestApp(db, testConfig(jobsDir), createStubMailer());

  const { id } = seedAbgeschlossenJobWithFile(db, jobsDir);
  updateKontierungMetadaten(db, id, {
    absender: 'lieferant@example.org',
    lieferant: 'Muster AG',
    rechnungsnummer: 'RE-2026-042',
    betrag: '123.45',
    zahlungsziel: '2026-09-01',
  });

  const res = await request(app).get('/api/n8n/jobs/abholbereit').set('X-API-Key', 'n8n-key');
  assert.equal(res.status, 200);
  assert.equal(res.body[0].lieferant, 'Muster AG');
  assert.equal(res.body[0].rechnungsnummer, 'RE-2026-042');
  assert.equal(res.body[0].betrag, '123.45');
  assert.equal(res.body[0].zahlungsziel, '2026-09-01');

  db.close();
  rmSync(jobsDir, { recursive: true, force: true });
});

test('POST /api/n8n/jobs/:id/abholung-bestaetigen confirms pickup, deletes the file, and rejects a second confirmation', async () => {
  const { mkdtempSync, existsSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const db = openDatabase(':memory:');
  const jobsDir = mkdtempSync(join(tmpdir(), 'jobs-test-'));
  const app = buildTestApp(db, testConfig(jobsDir), createStubMailer());

  const { id, pdfPfad } = seedAbgeschlossenJobWithFile(db, jobsDir);
  assert.ok(existsSync(pdfPfad));

  const firstRes = await request(app).post(`/api/n8n/jobs/${id}/abholung-bestaetigen`).set('X-API-Key', 'n8n-key');
  assert.equal(firstRes.status, 200);
  assert.equal(firstRes.body.status, 'abgeholt');
  assert.equal(existsSync(pdfPfad), false);

  const secondRes = await request(app).post(`/api/n8n/jobs/${id}/abholung-bestaetigen`).set('X-API-Key', 'n8n-key');
  assert.equal(secondRes.status, 409);

  db.close();
  rmSync(jobsDir, { recursive: true, force: true });
});

test('POST /api/n8n/jobs/:id/abholung-bestaetigen returns 409 for an abgeschlossen job without a Zeitstempel while a TSA is configured, and does not delete the file', async () => {
  const { mkdtempSync, existsSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const db = openDatabase(':memory:');
  const jobsDir = mkdtempSync(join(tmpdir(), 'jobs-test-'));
  const app = buildTestApp(db, testConfig(jobsDir), createStubMailer());
  setConfigValue(db, 'zeitstempel_tsa_url', 'https://tsa.example.org/tsr');

  const { id, pdfPfad } = seedAbgeschlossenJobWithFile(db, jobsDir);

  const res = await request(app).post(`/api/n8n/jobs/${id}/abholung-bestaetigen`).set('X-API-Key', 'n8n-key');
  assert.equal(res.status, 409);
  assert.equal(getJobById(db, id).status, 'abgeschlossen');
  assert.ok(existsSync(pdfPfad), 'the PDF must not be deleted while the Zeitstempel is still pending');

  db.close();
  rmSync(jobsDir, { recursive: true, force: true });
});

test('POST /api/n8n/jobs/:id/abholung-bestaetigen still confirms pickup normally when no TSA is configured (feature disabled)', async () => {
  const { mkdtempSync, existsSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const db = openDatabase(':memory:');
  const jobsDir = mkdtempSync(join(tmpdir(), 'jobs-test-'));
  const app = buildTestApp(db, testConfig(jobsDir), createStubMailer());

  const { id, pdfPfad } = seedAbgeschlossenJobWithFile(db, jobsDir);

  const res = await request(app).post(`/api/n8n/jobs/${id}/abholung-bestaetigen`).set('X-API-Key', 'n8n-key');
  assert.equal(res.status, 200);
  assert.equal(getJobById(db, id).status, 'abgeholt');
  assert.equal(existsSync(pdfPfad), false);

  db.close();
  rmSync(jobsDir, { recursive: true, force: true });
});

test('POST /api/n8n/jobs/:id/abholung-bestaetigen also deletes the thumbnail file, and does not error when thumbnail_pfad is null', async () => {
  const { mkdtempSync, existsSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const db = openDatabase(':memory:');
  const jobsDir = mkdtempSync(join(tmpdir(), 'jobs-test-'));
  const app = buildTestApp(db, testConfig(jobsDir), createStubMailer());

  const { id, pdfPfad } = seedAbgeschlossenJobWithFile(db, jobsDir);
  const thumbnailPfad = pdfPfad.replace(/\.pdf$/, '.png');
  writeFileSync(thumbnailPfad, Buffer.from('89504e470d0a1a0a', 'hex'));
  setThumbnailPfad(db, id, thumbnailPfad);
  assert.ok(existsSync(thumbnailPfad));

  const res = await request(app).post(`/api/n8n/jobs/${id}/abholung-bestaetigen`).set('X-API-Key', 'n8n-key');
  assert.equal(res.status, 200);
  assert.equal(existsSync(pdfPfad), false);
  assert.equal(existsSync(thumbnailPfad), false, 'thumbnail file should be deleted alongside the PDF on pickup confirmation');

  db.close();
  rmSync(jobsDir, { recursive: true, force: true });
});

test('POST /api/n8n/jobs with a real PDF sets thumbnail_pfad to a valid PNG file', async () => {
  const { mkdtempSync, rmSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const db = openDatabase(':memory:');
  const jobsDir = mkdtempSync(join(tmpdir(), 'jobs-test-'));
  const app = buildTestApp(db, testConfig(jobsDir), createStubMailer());
  const realPdf = await buildPdfFixture(['Rechnung Seite 1', 'Visum / Rechnungsfreigabe']);

  const res = await request(app)
    .post('/api/n8n/jobs')
    .set('X-API-Key', 'n8n-key')
    .field('quelle', 'scanner')
    .field('dateiname', 'scan.pdf')
    .attach('pdf', realPdf, { filename: 'scan.pdf', contentType: 'application/pdf' });

  assert.equal(res.status, 201);
  const job = getJobById(db, res.body.id);
  assert.ok(job.thumbnail_pfad, 'thumbnail_pfad should be set');
  const pngBytes = readFileSync(job.thumbnail_pfad);
  assert.equal(pngBytes.subarray(0, 4).toString('hex'), '89504e47');

  db.close();
  rmSync(jobsDir, { recursive: true, force: true });
});

test('POST /api/n8n/jobs still creates the job with 201 and thumbnail_pfad null when the PDF cannot be rendered as a thumbnail', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const db = openDatabase(':memory:');
  const jobsDir = mkdtempSync(join(tmpdir(), 'jobs-test-'));
  const app = buildTestApp(db, testConfig(jobsDir), createStubMailer());

  const res = await request(app)
    .post('/api/n8n/jobs')
    .set('X-API-Key', 'n8n-key')
    .field('quelle', 'scanner')
    .field('dateiname', 'scan.pdf')
    .attach('pdf', PDF_BYTES, { filename: 'scan.pdf', contentType: 'application/pdf' });

  assert.equal(res.status, 201);
  const job = getJobById(db, res.body.id);
  assert.equal(job.thumbnail_pfad, null);

  db.close();
  rmSync(jobsDir, { recursive: true, force: true });
});

test('POST /api/n8n/jobs with a matching Zuweisungsregel sends a Zuweisungs-Mail to freigeber1', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { upsertPerson } = await import('../../../src/db/personenRepo.js');
  const { createKonto } = await import('../../../src/db/kontenRepo.js');
  const { createDebitor } = await import('../../../src/db/debitorenRepo.js');
  const { createZuweisungsregel } = await import('../../../src/db/zuweisungsregelnRepo.js');
  const { listMailLog } = await import('../../../src/db/mailLogRepo.js');

  const db = openDatabase(':memory:');
  const jobsDir = mkdtempSync(join(tmpdir(), 'jobs-mail-test-'));
  for (const id of ['1', '2', '3', '4']) {
    upsertPerson(db, { id, vorname: `Person${id}`, nachname: 'Muster', email: `p${id}@example.org`, gruppen: ['10'], loggedInNow: false });
  }
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  const debitorId = createDebitor(db, { name: 'Muster AG', kontoId });
  createZuweisungsregel(db, { absenderMuster: 'lieferant.ch', debitorId });

  const config = { ...testConfig(jobsDir), publicBaseUrl: 'https://portal.example.org' };
  const mailer = createStubMailer();
  const app = buildTestApp(db, config, mailer);

  const res = await request(app)
    .post('/api/n8n/jobs')
    .set('X-API-Key', 'n8n-key')
    .field('quelle', 'lieferant')
    .field('absender', 'rechnungen@lieferant.ch')
    .field('dateiname', 'rechnung.pdf')
    .attach('pdf', PDF_BYTES, { filename: 'rechnung.pdf', contentType: 'application/pdf' });

  assert.equal(res.status, 201);
  assert.equal(mailer.sent.length, 1);
  assert.equal(mailer.sent[0].to, 'p1@example.org');
  assert.match(mailer.sent[0].text, /rechnung\.pdf/);
  assert.match(mailer.sent[0].text, new RegExp(`https://portal\\.example\\.org/kontierung/${res.body.id}`));

  const rows = listMailLog(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].typ, 'zuweisung');
  assert.equal(rows[0].status, 'versendet');
  db.close();
});

test('POST /api/n8n/jobs with no matching Zuweisungsregel sends no mail (job lands in the pool, no specific owner yet)', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { listMailLog } = await import('../../../src/db/mailLogRepo.js');

  const db = openDatabase(':memory:');
  const jobsDir = mkdtempSync(join(tmpdir(), 'jobs-mail-test-'));
  const config = { ...testConfig(jobsDir), publicBaseUrl: 'https://portal.example.org' };
  const mailer = createStubMailer();
  const app = buildTestApp(db, config, mailer);

  const res = await request(app)
    .post('/api/n8n/jobs')
    .set('X-API-Key', 'n8n-key')
    .field('quelle', 'scanner')
    .field('dateiname', 'scan.pdf')
    .attach('pdf', PDF_BYTES, { filename: 'scan.pdf', contentType: 'application/pdf' });

  assert.equal(res.status, 201);
  assert.equal(mailer.sent.length, 0);
  assert.equal(listMailLog(db).length, 0);
  db.close();
});

test('POST /:id/abholung-bestaetigen still marks the job abgeholt even if deleting its PDF throws', async () => {
  const { mkdtempSync, rmSync, mkdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'abholung-unlink-fail-test-'));
  const jobsDir = mkdtempSync(join(tmpdir(), 'jobs-test-'));
  const config = testConfig(jobsDir);
  const db = openDatabase(':memory:');
  const app = buildTestApp(db, config, createStubMailer());

  // pdf_pfad points at a directory, not a file. unlinkSync() on a directory always throws
  // EISDIR/EPERM on every platform and every user (including root, unlike a chmod-based
  // permission-denial test, which root silently ignores) — a deterministic way to force the
  // route's delete step to fail without relying on filesystem permissions.
  const pdfPfad = join(dir, 'job-is-actually-a-dir.pdf');
  mkdirSync(pdfPfad);
  const jobId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad });
  db.prepare("UPDATE jobs SET status = 'abgeschlossen' WHERE id = ?").run(jobId);

  const res = await request(app).post(`/api/n8n/jobs/${jobId}/abholung-bestaetigen`).set('X-API-Key', 'n8n-key');

  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'abgeholt');
  assert.equal(getJobById(db, jobId).status, 'abgeholt');

  rmSync(dir, { recursive: true, force: true });
  rmSync(jobsDir, { recursive: true, force: true });
  db.close();
});

test('POST /api/n8n/jobs decodes a real Swiss QR-Bill PDF and stores the qr_* fields', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { buildQrBillPdfFixture } = await import('../../helpers/qrBillFixture.js');
  const db = openDatabase(':memory:');
  const jobsDir = mkdtempSync(join(tmpdir(), 'jobs-test-'));
  const app = buildTestApp(db, testConfig(jobsDir), createStubMailer());

  const qrBillPdf = await buildQrBillPdfFixture({
    amount: 1949.75,
    creditor: { account: 'CH4431999123000889012', address: 'Musterstrasse', buildingNumber: 7, city: 'Musterstadt', country: 'CH', name: 'Muster AG', zip: 1234 },
    currency: 'CHF',
    debtor: { address: 'Musterstrasse', buildingNumber: 1, city: 'Musterstadt', country: 'CH', name: 'Peter Muster', zip: 1234 },
    reference: '210000000003139471430009017',
  });

  const res = await request(app)
    .post('/api/n8n/jobs')
    .set('X-API-Key', 'n8n-key')
    .field('quelle', 'lieferant')
    .field('dateiname', 'rechnung.pdf')
    .attach('pdf', qrBillPdf, { filename: 'rechnung.pdf', contentType: 'application/pdf' });

  assert.equal(res.status, 201);
  const job = getJobById(db, res.body.id);
  assert.equal(job.qr_iban, 'CH4431999123000889012');
  assert.equal(job.qr_creditor_name, 'Muster AG');
  assert.equal(job.qr_betrag, '1949.75');
  assert.equal(job.qr_waehrung, 'CHF');
  assert.equal(job.qr_referenz, '210000000003139471430009017');
  assert.ok(job.qr_erkannt_am);

  db.close();
  rmSync(jobsDir, { recursive: true, force: true });
});

test('POST /api/n8n/jobs still creates the job with qr_* columns null when the PDF has no QR-Code', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const db = openDatabase(':memory:');
  const jobsDir = mkdtempSync(join(tmpdir(), 'jobs-test-'));
  const app = buildTestApp(db, testConfig(jobsDir), createStubMailer());

  const res = await request(app)
    .post('/api/n8n/jobs')
    .set('X-API-Key', 'n8n-key')
    .field('quelle', 'scanner')
    .field('dateiname', 'scan.pdf')
    .attach('pdf', PDF_BYTES, { filename: 'scan.pdf', contentType: 'application/pdf' });

  assert.equal(res.status, 201);
  const job = getJobById(db, res.body.id);
  assert.equal(job.qr_iban, null);
  assert.equal(job.qr_erkannt_am, null);

  db.close();
  rmSync(jobsDir, { recursive: true, force: true });
});
