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

// --- Filter der Änderungshistorie (Parameter h_*) ---
import { auditedJob } from '../../../src/services/auditOperation.js';

async function seedLaeufe(db) {
  await auditedJob('audit-export', () => ({ status: 'fehler' }))(db);
  await auditedJob('zeitstempel-nachholen', () => ({ status: 'erfolg' }))(db);
  db.prepare(`INSERT INTO audit_ereignisse (zeitpunkt, person_id, person_name, objekt, objekt_id, aktion, nachher)
    VALUES ('2026-01-05T10:00:00.000Z', '528', 'Rony Spitzer', 'admin_config', 'audit_zeitstempel_alarm_tage', 'UPDATE', '{"value":"3"}')`).run();
}

test('Änderungshistorie: h_lauf zeigt nur Einträge dieses Laufs', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  await seedLaeufe(db);
  const res = await request(buildTestApp(db)).get('/admin/audit-log?h_lauf=audit-export').set('x-test-person-id', '99');
  assert.equal(res.status, 200);
  assert.match(res.text, /Lauf: audit-export/);
  assert.doesNotMatch(res.text, /Lauf: zeitstempel-nachholen/);
  assert.doesNotMatch(res.text, /audit_zeitstempel_alarm_tage #|admin_config #audit_zeitstempel_alarm_tage/);
  // Auswahl bietet die vorhandenen Lauf-Typen an
  assert.match(res.text, /<option value="zeitstempel-nachholen"/);
  db.close();
});

test('Änderungshistorie: h_objekt, h_aktion, h_person und h_q filtern', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  await seedLaeufe(db);
  const app = buildTestApp(db);
  let res = await request(app).get('/admin/audit-log?h_objekt=admin_config').set('x-test-person-id', '99');
  assert.match(res.text, /admin_config #audit_zeitstempel_alarm_tage/);
  assert.doesNotMatch(res.text, /Lauf: audit-export/);

  res = await request(app).get('/admin/audit-log?h_aktion=lauf_beendet&h_q=fehler').set('x-test-person-id', '99');
  assert.match(res.text, /Lauf: audit-export/);
  assert.doesNotMatch(res.text, /Lauf: zeitstempel-nachholen/);

  res = await request(app).get('/admin/audit-log?h_person=spitzer').set('x-test-person-id', '99');
  assert.match(res.text, /admin_config #audit_zeitstempel_alarm_tage/);
  assert.doesNotMatch(res.text, /Lauf: audit-export/);
  db.close();
});

test('Änderungshistorie: Zeitraum filtert inklusive Bis-Tag; leeres Ergebnis zeigt Hinweis', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  await seedLaeufe(db);
  const app = buildTestApp(db);
  let res = await request(app).get('/admin/audit-log?h_von=2026-01-05&h_bis=2026-01-05').set('x-test-person-id', '99');
  assert.match(res.text, /admin_config #audit_zeitstempel_alarm_tage/);
  assert.doesNotMatch(res.text, /Lauf: audit-export/);
  res = await request(app).get('/admin/audit-log?h_q=gibtesnicht%25').set('x-test-person-id', '99');
  assert.equal(res.status, 200);
  assert.match(res.text, /Keine Änderungen gefunden/);
  db.close();
});

test('Änderungshistorie: "Ältere Änderungen" behält die Filter', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  for (let i = 0; i < 55; i += 1) await auditedJob('audit-export', () => ({ status: 'erfolg' }))(db);
  const res = await request(buildTestApp(db)).get('/admin/audit-log?h_lauf=audit-export').set('x-test-person-id', '99');
  const link = res.text.match(/href="\?([^"]*vor=\d+[^"]*)">Ältere Änderungen/);
  assert.ok(link, 'Link auf ältere Änderungen fehlt');
  assert.match(link[1].replace(/&amp;/g, '&'), /h_lauf=audit-export/);
  db.close();
});
