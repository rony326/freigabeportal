import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { openDatabase } from '../../../src/db/index.js';
import { upsertPerson } from '../../../src/db/personenRepo.js';
import { createJob } from '../../../src/db/jobsRepo.js';
import { createFreigabe } from '../../../src/db/freigabenRepo.js';
import { logJobLoeschung } from '../../../src/db/jobLoeschungenRepo.js';
import { loadCurrentPerson } from '../../../src/middleware/roles.js';
import { loadNavFlags } from '../../../src/middleware/nav.js';
import { requirePermission } from '../../../src/middleware/permissions.js';
import { setBerechtigungenForPerson } from '../../../src/db/personBerechtigungenRepo.js';
import { createAuditLogRouter } from '../../../src/routes/admin/auditLog.js';

function buildTestApp(db) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', new URL('../../../views', import.meta.url).pathname);
  app.use((req, res, next) => {
    res.locals.branding = { primaryColor: '#000', secondaryColor: '#fff', hasLogo: false, themeAttr: null };
    next();
  });
  app.use((req, res, next) => {
    req.session = { personId: req.headers['x-test-person-id'] };
    next();
  });
  const config = { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20', groupIdManager: '30' } };
  app.use(loadCurrentPerson(db));
  app.use(loadNavFlags(db, config));
  app.use('/admin/audit-log', requirePermission(db, config, 'audit_log_einsehen'), createAuditLogRouter({ db }));
  return app;
}

function seedAdmin(db) {
  upsertPerson(db, { id: '99', vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'], loggedInNow: true });
}

test('GET /admin/audit-log returns 401 without a session', async () => {
  const db = openDatabase(':memory:');
  const app = buildTestApp(db);
  const res = await request(app).get('/admin/audit-log');
  assert.equal(res.status, 401);
  db.close();
});

test('GET /admin/audit-log returns 403 for a logged-in person without the permission', async () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'Ohne', nachname: 'Recht', email: 'o@example.org', gruppen: [], loggedInNow: true });
  const app = buildTestApp(db);
  const res = await request(app).get('/admin/audit-log').set('x-test-person-id', '1');
  assert.equal(res.status, 403);
  db.close();
});

test('GET /admin/audit-log returns 200 and lists freigaben and job_loeschungen entries for Superadmin', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  const jobA = createJob(db, { eingangAm: '2026-08-01T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'rechnung-a.pdf', pdfPfad: '/tmp/a.pdf' });
  createFreigabe(db, { jobId: jobA, personId: '99', rolle: 'freigeber1', zeitpunkt: '2026-08-01T09:00:00.000Z', ip: '127.0.0.1', interessenskonflikt: false, kommentar: null, eskaliertVon: null });
  const jobB = createJob(db, { eingangAm: '2026-08-02T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'rechnung-b.pdf', pdfPfad: '/tmp/b.pdf' });
  logJobLoeschung(db, { jobId: jobB, dateiname: 'rechnung-b.pdf', geloeschtVon: '99', begruendung: 'Duplikat' });

  const app = buildTestApp(db);
  const res = await request(app).get('/admin/audit-log').set('x-test-person-id', '99');
  assert.equal(res.status, 200);
  assert.match(res.text, /rechnung-a\.pdf/);
  assert.match(res.text, /rechnung-b\.pdf/);
  assert.match(res.text, /Job gelöscht/);
  db.close();
});

test('GET /admin/audit-log?typ=loeschung filters to only job_loeschungen entries', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  const jobA = createJob(db, { eingangAm: '2026-08-01T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'rechnung-a.pdf', pdfPfad: '/tmp/a.pdf' });
  createFreigabe(db, { jobId: jobA, personId: '99', rolle: 'freigeber1', zeitpunkt: '2026-08-01T09:00:00.000Z', ip: '127.0.0.1', interessenskonflikt: false, kommentar: null, eskaliertVon: null });
  const jobB = createJob(db, { eingangAm: '2026-08-02T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'rechnung-b.pdf', pdfPfad: '/tmp/b.pdf' });
  logJobLoeschung(db, { jobId: jobB, dateiname: 'rechnung-b.pdf', geloeschtVon: '99', begruendung: 'Duplikat' });

  const app = buildTestApp(db);
  const res = await request(app).get('/admin/audit-log?typ=loeschung').set('x-test-person-id', '99');
  assert.equal(res.status, 200);
  assert.doesNotMatch(res.text, /rechnung-a\.pdf/);
  assert.match(res.text, /rechnung-b\.pdf/);
  db.close();
});

test('GET /admin/audit-log returns 200 for a plain person with exactly the audit_log_einsehen grant', async () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'Nur', nachname: 'Audit', email: 'nur@example.org', gruppen: [], loggedInNow: true });
  setBerechtigungenForPerson(db, '1', ['audit_log_einsehen']);
  const app = buildTestApp(db);
  const res = await request(app).get('/admin/audit-log').set('x-test-person-id', '1');
  assert.equal(res.status, 200);
  db.close();
});

test('GET /admin/audit-log with no entries shows an empty-state message instead of erroring', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  const app = buildTestApp(db);
  const res = await request(app).get('/admin/audit-log').set('x-test-person-id', '99');
  assert.equal(res.status, 200);
  assert.match(res.text, /Keine Einträge gefunden/);
  db.close();
});

test('GET /admin/audit-log shows the total entry count', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  const jobA = createJob(db, { eingangAm: '2026-08-01T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'rechnung-a.pdf', pdfPfad: '/tmp/a.pdf' });
  createFreigabe(db, { jobId: jobA, personId: '99', rolle: 'freigeber1', zeitpunkt: '2026-08-01T09:00:00.000Z', ip: '127.0.0.1', interessenskonflikt: false, kommentar: null, eskaliertVon: null });
  const jobB = createJob(db, { eingangAm: '2026-08-02T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'rechnung-b.pdf', pdfPfad: '/tmp/b.pdf' });
  logJobLoeschung(db, { jobId: jobB, dateiname: 'rechnung-b.pdf', geloeschtVon: '99', begruendung: 'Duplikat' });

  const app = buildTestApp(db);
  const res = await request(app).get('/admin/audit-log').set('x-test-person-id', '99');
  assert.equal(res.status, 200);
  assert.match(res.text, /2 Einträge/);
  db.close();
});

test('GET /admin/audit-log?seite=99 clamps to the last real page instead of showing an empty state', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  const job = createJob(db, { eingangAm: '2026-08-01T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'rechnung-a.pdf', pdfPfad: '/tmp/a.pdf' });
  createFreigabe(db, { jobId: job, personId: '99', rolle: 'freigeber1', zeitpunkt: '2026-08-01T09:00:00.000Z', ip: '127.0.0.1', interessenskonflikt: false, kommentar: null, eskaliertVon: null });

  const app = buildTestApp(db);
  const res = await request(app).get('/admin/audit-log?seite=99').set('x-test-person-id', '99');
  assert.equal(res.status, 200);
  assert.doesNotMatch(res.text, /Keine Einträge gefunden/);
  assert.match(res.text, /rechnung-a\.pdf/);
  db.close();
});

test('GET /admin/audit-log renders the disabled "Zurück" pagination control as non-focusable on the first page', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  const job = createJob(db, { eingangAm: '2026-08-01T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'rechnung-a.pdf', pdfPfad: '/tmp/a.pdf' });
  createFreigabe(db, { jobId: job, personId: '99', rolle: 'freigeber1', zeitpunkt: '2026-08-01T09:00:00.000Z', ip: '127.0.0.1', interessenskonflikt: false, kommentar: null, eskaliertVon: null });

  const app = buildTestApp(db);
  const res = await request(app).get('/admin/audit-log').set('x-test-person-id', '99');
  assert.equal(res.status, 200);
  assert.doesNotMatch(res.text, /<a[^>]*>Zurück<\/a>/, 'a disabled "Zurück" link must not remain a focusable/operable <a>');
  db.close();
});
