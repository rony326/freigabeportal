import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../../src/db/index.js';
import { seedDefaults, getConfigValue, setConfigValue } from '../../../src/db/adminConfigRepo.js';
import { upsertPerson } from '../../../src/db/personenRepo.js';
import { createJob, getJobById } from '../../../src/db/jobsRepo.js';
import { startCronLauf } from '../../../src/db/cronLogRepo.js';
import { listMailLog } from '../../../src/db/mailLogRepo.js';
import { loadCurrentPerson } from '../../../src/middleware/roles.js';
import { loadNavFlags } from '../../../src/middleware/nav.js';
import { requirePermission } from '../../../src/middleware/permissions.js';
import { setBerechtigungenForPerson } from '../../../src/db/personBerechtigungenRepo.js';
import { createGeplanteJobsRouter } from '../../../src/routes/admin/geplanteJobs.js';
import { setupMockChurchTools } from '../../helpers/mockChurchTools.js';
import { setupMockTsa } from '../../helpers/mockTsa.js';
import { buildPdfFixture } from '../../helpers/pdfFixture.js';

function createStubMailer({ shouldFail = false } = {}) {
  const sent = [];
  return { sent, async sendMail(mail) { sent.push(mail); if (shouldFail) throw new Error('SMTP-Testfehler'); } };
}

function buildTestApp(db, { config, mailer } = {}) {
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
  const resolvedConfig = config || { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20', groupIdManager: '30' } };
  app.use(loadCurrentPerson(db));
  app.use(loadNavFlags(db, resolvedConfig));
  app.use(
    '/admin/geplante-jobs',
    requirePermission(db, resolvedConfig, 'geplante_jobs_verwalten'),
    createGeplanteJobsRouter({ db, config: resolvedConfig, mailer: mailer || createStubMailer() })
  );
  return app;
}

function seedAdmin(db) {
  upsertPerson(db, { id: '99', vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'], loggedInNow: true });
}

const VALID_BODY = {
  syncPersonenStunde: '3',
  syncPersonenMinute: '15',
  poolErinnerungenIntervallMinuten: '30',
  pdfBereinigungStunde: '4',
  pdfBereinigungMinute: '45',
  zeitstempelNachholenIntervallMinuten: '10',
};

const GEPLANTE_JOBS_ROUTES = [
  { method: 'get', path: '/admin/geplante-jobs' },
  { method: 'post', path: '/admin/geplante-jobs' },
  { method: 'post', path: '/admin/geplante-jobs/sync-personen/jetzt-ausfuehren' },
  { method: 'post', path: '/admin/geplante-jobs/pool-erinnerungen/jetzt-ausfuehren' },
  { method: 'post', path: '/admin/geplante-jobs/pdf-bereinigung/jetzt-ausfuehren' },
  { method: 'post', path: '/admin/geplante-jobs/zeitstempel-nachholen/jetzt-ausfuehren' },
];

test('every Geplante-Jobs route returns 401 without any session, and config is untouched', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  const app = buildTestApp(db);
  for (const { method, path } of GEPLANTE_JOBS_ROUTES) {
    const res = await request(app)[method](path).type('form').send(VALID_BODY);
    assert.equal(res.status, 401, `${method.toUpperCase()} ${path} should be 401 without a session`);
  }
  assert.equal(getConfigValue(db, 'cron_sync_personen_stunde'), '2');
  db.close();
});

test('every Geplante-Jobs route returns 403 for a logged-in non-admin (buchhaltung only)', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  upsertPerson(db, { id: '77', vorname: 'Nur', nachname: 'Buchhaltung', email: 'b@example.org', gruppen: ['10'], loggedInNow: true });
  const app = buildTestApp(db);
  for (const { method, path } of GEPLANTE_JOBS_ROUTES) {
    const res = await request(app)[method](path).set('x-test-person-id', '77').type('form').send(VALID_BODY);
    assert.equal(res.status, 403, `${method.toUpperCase()} ${path} should be 403 for a non-admin`);
  }
  db.close();
});

test('GET /admin/geplante-jobs shows the configured schedule values pre-filled', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  setConfigValue(db, 'cron_sync_personen_stunde', '5');
  setConfigValue(db, 'cron_pool_erinnerungen_intervall_minuten', '20');
  seedAdmin(db);
  const app = buildTestApp(db);
  const res = await request(app).get('/admin/geplante-jobs').set('x-test-person-id', '99');
  assert.equal(res.status, 200);
  assert.match(res.text, /id="syncPersonenStunde"[^>]*value="5"/);
  assert.match(res.text, /id="poolErinnerungenIntervallMinuten"[^>]*value="20"/);
  db.close();
});

test('POST /admin/geplante-jobs persists a valid schedule', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  const app = buildTestApp(db);
  const res = await request(app).post('/admin/geplante-jobs').set('x-test-person-id', '99').type('form').send(VALID_BODY);
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/admin/geplante-jobs?gespeichert=1');
  assert.equal(getConfigValue(db, 'cron_sync_personen_stunde'), '3');
  assert.equal(getConfigValue(db, 'cron_sync_personen_minute'), '15');
  assert.equal(getConfigValue(db, 'cron_pool_erinnerungen_intervall_minuten'), '30');
  assert.equal(getConfigValue(db, 'cron_pdf_bereinigung_stunde'), '4');
  assert.equal(getConfigValue(db, 'cron_pdf_bereinigung_minute'), '45');
  assert.equal(getConfigValue(db, 'cron_zeitstempel_nachholen_intervall_minuten'), '10');
  db.close();
});

test('POST /admin/geplante-jobs rejects an out-of-range hour, config untouched', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  const app = buildTestApp(db);
  const res = await request(app)
    .post('/admin/geplante-jobs')
    .set('x-test-person-id', '99')
    .type('form')
    .send({ ...VALID_BODY, syncPersonenStunde: '24' });
  assert.equal(res.status, 400);
  assert.match(res.text, /Ganzzahl zwischen 0 und 23/);
  assert.equal(getConfigValue(db, 'cron_sync_personen_stunde'), '2');
  db.close();
});

test('POST /admin/geplante-jobs rejects a non-positive interval, config untouched', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  const app = buildTestApp(db);
  const res = await request(app)
    .post('/admin/geplante-jobs')
    .set('x-test-person-id', '99')
    .type('form')
    .send({ ...VALID_BODY, poolErinnerungenIntervallMinuten: '0' });
  assert.equal(res.status, 400);
  assert.match(res.text, /positive Ganzzahl/);
  assert.equal(getConfigValue(db, 'cron_pool_erinnerungen_intervall_minuten'), '60');
  db.close();
});

test('POST /admin/geplante-jobs rejects a non-positive zeitstempel-nachholen interval, config untouched', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  const app = buildTestApp(db);
  const res = await request(app)
    .post('/admin/geplante-jobs')
    .set('x-test-person-id', '99')
    .type('form')
    .send({ ...VALID_BODY, zeitstempelNachholenIntervallMinuten: '0' });
  assert.equal(res.status, 400);
  assert.match(res.text, /Zeitstempel-Nachholen: Intervall muss eine positive Ganzzahl/);
  assert.equal(getConfigValue(db, 'cron_zeitstempel_nachholen_intervall_minuten'), '5');
  db.close();
});

test('POST /admin/geplante-jobs/sync-personen/jetzt-ausfuehren runs the sync now and shows a success banner with the result', async () => {
  const config = {
    churchtools: { baseUrl: 'https://ct.example.org', groupIdBuchhaltung: '10', groupIdAdmin: '20', syncServiceToken: 'token' },
    publicBaseUrl: 'https://portal.example.org',
  };
  const client = setupMockChurchTools(config.churchtools.baseUrl);
  // The admin account (99) must come back as a resolvable member of its own group -- otherwise
  // the sync it just triggered would deactivate it (a lone active person's departure isn't
  // caught by the mass-deactivation guard, see sync.js's "population of exactly one" comment),
  // and the very next request as that person would 401.
  client.intercept({ path: '/api/groups/10/members', method: 'GET' }).reply(200, { data: [] });
  client.intercept({ path: '/api/groups/20/members', method: 'GET' }).reply(200, { data: [{ personId: 99 }] });
  client
    .intercept({ path: '/api/persons/99', method: 'GET' })
    .reply(200, { data: { firstName: 'Admina', lastName: 'Portal', email: 'admin@example.org' } });

  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  const app = buildTestApp(db, { config });

  const triggerRes = await request(app).post('/admin/geplante-jobs/sync-personen/jetzt-ausfuehren').set('x-test-person-id', '99');
  assert.equal(triggerRes.status, 302);
  assert.equal(triggerRes.headers.location, '/admin/geplante-jobs?getriggert=sync-personen');

  const res = await request(app).get(triggerRes.headers.location).set('x-test-person-id', '99');
  assert.equal(res.status, 200);
  assert.match(res.text, /alert-success/);
  assert.match(res.text, /Erfolgreich ausgeführt/);
  db.close();
});

test('POST /admin/geplante-jobs/pool-erinnerungen/jetzt-ausfuehren runs it now, logs the result, and shows feedback', async () => {
  const config = { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20' }, publicBaseUrl: 'https://portal.example.org' };
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  upsertPerson(db, { id: '1', vorname: 'Buch', nachname: 'Halter', email: 'buch@example.org', gruppen: ['10'], loggedInNow: false });
  createJob(db, { eingangAm: '2020-01-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'alt.pdf', pdfPfad: '/tmp/a.pdf' });
  const mailer = createStubMailer();
  const app = buildTestApp(db, { config, mailer });

  const triggerRes = await request(app).post('/admin/geplante-jobs/pool-erinnerungen/jetzt-ausfuehren').set('x-test-person-id', '99');
  assert.equal(triggerRes.status, 302);
  assert.equal(triggerRes.headers.location, '/admin/geplante-jobs?getriggert=pool-erinnerungen');
  assert.equal(mailer.sent.length, 2, 'one reminder mail and one eskalation mail for the very-stale job');
  assert.equal(listMailLog(db).length, 2);

  const res = await request(app).get(triggerRes.headers.location).set('x-test-person-id', '99');
  assert.equal(res.status, 200);
  assert.match(res.text, /alert-success/);
  assert.match(res.text, /Reminder: 1, Eskalation: 1/);
  db.close();
});

test('POST /admin/geplante-jobs/pool-erinnerungen/jetzt-ausfuehren shows a failure banner and logs status=fehler when the job throws', async () => {
  const config = { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20' }, publicBaseUrl: 'https://portal.example.org' };
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  // Non-numeric reminder_stunden -> Number(...) is NaN -> listPoolJobsForReminder's date math throws.
  setConfigValue(db, 'reminder_stunden', 'kaputt');
  createJob(db, { eingangAm: '2020-01-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'alt.pdf', pdfPfad: '/tmp/a.pdf' });
  const app = buildTestApp(db, { config });

  const triggerRes = await request(app).post('/admin/geplante-jobs/pool-erinnerungen/jetzt-ausfuehren').set('x-test-person-id', '99');
  assert.equal(triggerRes.status, 302);

  const res = await request(app).get(triggerRes.headers.location).set('x-test-person-id', '99');
  assert.equal(res.status, 200);
  assert.match(res.text, /alert-danger/);
  assert.match(res.text, /Fehlgeschlagen/);
  db.close();
});

test('POST /admin/geplante-jobs/pdf-bereinigung/jetzt-ausfuehren runs it now, logs the result, and shows feedback', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'geplante-jobs-test-'));
  const pdfPfad = join(dir, 'job.pdf');
  writeFileSync(pdfPfad, 'pdf-bytes');
  const config = { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20' }, jobsDir: dir };

  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  const jobId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad });
  db.prepare("UPDATE jobs SET status = 'abgeholt' WHERE id = ?").run(jobId);
  const app = buildTestApp(db, { config });

  const triggerRes = await request(app).post('/admin/geplante-jobs/pdf-bereinigung/jetzt-ausfuehren').set('x-test-person-id', '99');
  assert.equal(triggerRes.status, 302);
  assert.equal(triggerRes.headers.location, '/admin/geplante-jobs?getriggert=pdf-bereinigung');
  assert.equal(getJobById(db, jobId).status, 'archiviert');

  const res = await request(app).get(triggerRes.headers.location).set('x-test-person-id', '99');
  assert.equal(res.status, 200);
  assert.match(res.text, /alert-success/);
  assert.match(res.text, /Archiviert: 1/);

  rmSync(dir, { recursive: true, force: true });
  db.close();
});

test('POST /admin/geplante-jobs/zeitstempel-nachholen/jetzt-ausfuehren shows an alert-info banner (not a false failure) when a run is already laufend', async () => {
  // Task 4's overlap guard (mirroring hasRecentRunningSync) leaves the existing 'laufend' cron_log
  // row untouched and writes nothing new when a second invocation fires mid-run. The banner must
  // read that stale 'laufend' row as "already running", not as a failure -- see sync-personen's
  // analogous 3-way status check just above this section in the view.
  const config = { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20' } };
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  setConfigValue(db, 'zeitstempel_tsa_url', 'https://tsa.example.org/tsr');
  startCronLauf(db, 'zeitstempel-nachholen'); // simulates a still-in-progress run
  const app = buildTestApp(db, { config });

  const triggerRes = await request(app).post('/admin/geplante-jobs/zeitstempel-nachholen/jetzt-ausfuehren').set('x-test-person-id', '99');
  assert.equal(triggerRes.status, 302);
  assert.equal(triggerRes.headers.location, '/admin/geplante-jobs?getriggert=zeitstempel-nachholen');

  const res = await request(app).get(triggerRes.headers.location).set('x-test-person-id', '99');
  assert.equal(res.status, 200);
  assert.match(res.text, /alert-info/);
  assert.doesNotMatch(res.text, /alert-danger/);
  assert.match(res.text, /Ein Zeitstempel-Nachholen-Lauf war bereits aktiv/);
  db.close();
});

test('POST /admin/geplante-jobs/zeitstempel-nachholen/jetzt-ausfuehren runs it now, logs the result, and shows feedback', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'geplante-jobs-zeitstempel-test-'));
  const pdfPfad = join(dir, 'job.pdf');
  writeFileSync(pdfPfad, await buildPdfFixture(['Rechnung Seite 1']));
  const config = { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20' } };

  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  setConfigValue(db, 'zeitstempel_tsa_url', 'https://tsa.example.org/tsr');
  const jobId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad });
  db.prepare("UPDATE jobs SET status = 'abgeschlossen' WHERE id = ?").run(jobId);

  const rfc3161Response = readFileSync(new URL('../../fixtures/rfc3161-response.der', import.meta.url));
  const client = setupMockTsa('https://tsa.example.org/tsr');
  client.intercept({ path: '/tsr', method: 'POST' }).reply(200, rfc3161Response, { headers: { 'content-type': 'application/timestamp-reply' } });

  const app = buildTestApp(db, { config });

  const triggerRes = await request(app).post('/admin/geplante-jobs/zeitstempel-nachholen/jetzt-ausfuehren').set('x-test-person-id', '99');
  assert.equal(triggerRes.status, 302);
  assert.equal(triggerRes.headers.location, '/admin/geplante-jobs?getriggert=zeitstempel-nachholen');
  assert.ok(getJobById(db, jobId).zeitstempel_gesetzt_am);

  const res = await request(app).get(triggerRes.headers.location).set('x-test-person-id', '99');
  assert.equal(res.status, 200);
  assert.match(res.text, /alert-success/);
  assert.match(res.text, /Nachgeholt: 1/);

  rmSync(dir, { recursive: true, force: true });
  db.close();
});

test('GET /admin/geplante-jobs returns 200 for a Manager', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  upsertPerson(db, { id: '55', vorname: 'Mana', nachname: 'Ger', email: 'manager@example.org', gruppen: ['30'], loggedInNow: true });
  const app = buildTestApp(db);
  const res = await request(app).get('/admin/geplante-jobs').set('x-test-person-id', '55');
  assert.equal(res.status, 200);
  db.close();
});

test('GET /admin/geplante-jobs returns 200 for a plain person with exactly this individual grant, and 403 for a different one', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  upsertPerson(db, { id: '1', vorname: 'Nur', nachname: 'Abgelehnt', email: 'nur@example.org', gruppen: [], loggedInNow: true });
  setBerechtigungenForPerson(db, '1', ['abgelehnt_verwalten']);
  const app = buildTestApp(db);
  const res = await request(app).get('/admin/geplante-jobs').set('x-test-person-id', '1');
  assert.equal(res.status, 403);

  setBerechtigungenForPerson(db, '1', ['geplante_jobs_verwalten']);
  const res2 = await request(app).get('/admin/geplante-jobs').set('x-test-person-id', '1');
  assert.equal(res2.status, 200);
  db.close();
});
