import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupMockChurchTools } from '../helpers/mockChurchTools.js';
import { openDatabase } from '../../src/db/index.js';
import { createApp } from '../../src/app.js';
import { startSyncLog } from '../../src/db/syncLogRepo.js';

function testConfig() {
  return {
    sessionSecret: 'test-secret',
    env: 'test',
    cronSecret: 'cron-secret',
    churchtools: {
      baseUrl: 'https://ct.example.org',
      groupIdBuchhaltung: '10',
      groupIdAdmin: '20',
      syncServiceToken: 'service-token',
    },
  };
}

test('POST /internal/cron/sync-personen without the secret is rejected', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, config: testConfig() });
  const res = await request(app).post('/internal/cron/sync-personen');
  assert.equal(res.status, 401);
  db.close();
});

test('POST /internal/cron/sync-personen runs the sync with the correct secret', async () => {
  const config = testConfig();
  const client = setupMockChurchTools(config.churchtools.baseUrl);
  client.intercept({ path: '/api/groups/10/members', method: 'GET' }).reply(200, { data: [] });
  client.intercept({ path: '/api/groups/20/members', method: 'GET' }).reply(200, { data: [] });

  const db = openDatabase(':memory:');
  const app = createApp({ db, config });
  const res = await request(app).post('/internal/cron/sync-personen').set('X-Cron-Secret', 'cron-secret');

  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'erfolg');
  db.close();
});

test('POST /internal/cron/sync-personen returns 409 while a run is already active', async () => {
  const config = testConfig();
  const db = openDatabase(':memory:');
  startSyncLog(db);
  const app = createApp({ db, config });
  const res = await request(app).post('/internal/cron/sync-personen').set('X-Cron-Secret', 'cron-secret');
  assert.equal(res.status, 409);
  db.close();
});

test('POST /internal/cron/sync-personen returns abgebrochen and emails gruppe:admin when the mass-deactivation guard trips, without persisting anything', async () => {
  const config = testConfig();
  const client = setupMockChurchTools(config.churchtools.baseUrl);
  client.intercept({ path: '/api/groups/10/members', method: 'GET' }).reply(200, { data: [] });
  client.intercept({ path: '/api/groups/20/members', method: 'GET' }).reply(200, { data: [] });

  const db = openDatabase(':memory:');
  const { seedDefaults, setConfigValue } = await import('../../src/db/adminConfigRepo.js');
  const { upsertPerson, getPersonById } = await import('../../src/db/personenRepo.js');
  const { listMailLog } = await import('../../src/db/mailLogRepo.js');
  seedDefaults(db);
  setConfigValue(db, 'sync_max_deaktivierung_anzahl', '0');
  upsertPerson(db, { id: '1', vorname: 'Wird', nachname: 'Deaktiviert', email: 'weg@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '99', vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'], loggedInNow: false });

  const app = createApp({ db, config });
  const res = await request(app).post('/internal/cron/sync-personen').set('X-Cron-Secret', 'cron-secret');

  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'abgebrochen');
  assert.match(res.body.meldung, /Schwelle/);
  assert.equal(getPersonById(db, '1').aktiv, true, 'nothing should have been persisted');
  const syncFehlerMails = listMailLog(db).filter((m) => m.typ === 'sync-fehler');
  assert.equal(syncFehlerMails.length, 1);
  assert.equal(syncFehlerMails[0].empfaenger, 'admin@example.org');
  db.close();
});

test('POST /internal/cron/sync-personen emails gruppe:admin when the sync throws', async () => {
  const config = testConfig();
  const client = setupMockChurchTools(config.churchtools.baseUrl);
  client.intercept({ path: '/api/groups/10/members', method: 'GET' }).reply(500, {});
  client.intercept({ path: '/api/groups/20/members', method: 'GET' }).reply(200, { data: [] });

  const db = openDatabase(':memory:');
  const { seedDefaults } = await import('../../src/db/adminConfigRepo.js');
  const { upsertPerson } = await import('../../src/db/personenRepo.js');
  const { listMailLog } = await import('../../src/db/mailLogRepo.js');
  seedDefaults(db);
  upsertPerson(db, { id: '99', vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'], loggedInNow: false });

  const app = createApp({ db, config });
  const res = await request(app).post('/internal/cron/sync-personen').set('X-Cron-Secret', 'cron-secret');

  assert.equal(res.status, 500);
  assert.equal(res.body.status, 'fehler');
  const syncFehlerMails = listMailLog(db).filter((m) => m.typ === 'sync-fehler');
  assert.equal(syncFehlerMails.length, 1);
  db.close();
});

test('POST /internal/cron/sync-personen sends no sync-fehler mail on a normal successful run', async () => {
  const config = testConfig();
  const client = setupMockChurchTools(config.churchtools.baseUrl);
  client.intercept({ path: '/api/groups/10/members', method: 'GET' }).reply(200, { data: [] });
  client.intercept({ path: '/api/groups/20/members', method: 'GET' }).reply(200, { data: [] });

  const db = openDatabase(':memory:');
  const { seedDefaults } = await import('../../src/db/adminConfigRepo.js');
  const { listMailLog } = await import('../../src/db/mailLogRepo.js');
  seedDefaults(db);

  const app = createApp({ db, config });
  const res = await request(app).post('/internal/cron/sync-personen').set('X-Cron-Secret', 'cron-secret');

  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'erfolg');
  assert.equal(listMailLog(db).filter((m) => m.typ === 'sync-fehler').length, 0);
  db.close();
});

function createStubMailer() {
  const sent = [];
  return { sent, async sendMail(mail) { sent.push(mail); } };
}

test('POST /internal/cron/pool-erinnerungen without the secret is rejected', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, config: testConfig() });
  const res = await request(app).post('/internal/cron/pool-erinnerungen');
  assert.equal(res.status, 401);
  db.close();
});

test('POST /internal/cron/pool-erinnerungen sends one reminder mail per stale pool job and marks it sent, is idempotent on a second run', async () => {
  const { seedDefaults } = await import('../../src/db/adminConfigRepo.js');
  const { createJob, getJobById } = await import('../../src/db/jobsRepo.js');
  const { listMailLog } = await import('../../src/db/mailLogRepo.js');
  const db = openDatabase(':memory:');
  seedDefaults(db);
  const jobId = createJob(db, { eingangAm: '2020-01-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'alt.pdf', pdfPfad: '/tmp/a.pdf' });
  const { upsertPerson } = await import('../../src/db/personenRepo.js');
  upsertPerson(db, { id: '1', vorname: 'Buch', nachname: 'Halter', email: 'buch@example.org', gruppen: ['10'], loggedInNow: false });

  const config = { ...testConfig(), publicBaseUrl: 'https://portal.example.org' };
  const client = setupMockChurchTools(config.churchtools.baseUrl);
  const app = createApp({ db, config });

  const res1 = await request(app).post('/internal/cron/pool-erinnerungen').set('X-Cron-Secret', 'cron-secret');
  assert.equal(res1.status, 200);
  assert.equal(res1.body.reminder, 1);
  assert.equal(getJobById(db, jobId).reminder_gesendet_at !== null, true);
  assert.equal(listMailLog(db).filter((m) => m.typ === 'reminder').length, 1);

  const res2 = await request(app).post('/internal/cron/pool-erinnerungen').set('X-Cron-Secret', 'cron-secret');
  assert.equal(res2.status, 200);
  assert.equal(res2.body.reminder, 0, 'the same job must not be reminded twice');
  assert.equal(listMailLog(db).filter((m) => m.typ === 'reminder').length, 1);
  db.close();
});

test('POST /internal/cron/pool-erinnerungen sends escalation mail independently of reminder, both can fire for the same very-stale job', async () => {
  const { seedDefaults } = await import('../../src/db/adminConfigRepo.js');
  const { createJob } = await import('../../src/db/jobsRepo.js');
  const { listMailLog } = await import('../../src/db/mailLogRepo.js');
  const { upsertPerson } = await import('../../src/db/personenRepo.js');
  const db = openDatabase(':memory:');
  seedDefaults(db);
  createJob(db, { eingangAm: '2020-01-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'alt.pdf', pdfPfad: '/tmp/a.pdf' });
  upsertPerson(db, { id: '1', vorname: 'Buch', nachname: 'Halter', email: 'buch@example.org', gruppen: ['10'], loggedInNow: false });

  const config = { ...testConfig(), publicBaseUrl: 'https://portal.example.org' };
  const app = createApp({ db, config });

  const res = await request(app).post('/internal/cron/pool-erinnerungen').set('X-Cron-Secret', 'cron-secret');
  assert.equal(res.status, 200);
  assert.equal(res.body.reminder, 1);
  assert.equal(res.body.eskalation, 1);
  assert.equal(listMailLog(db).filter((m) => m.typ === 'reminder').length, 1);
  assert.equal(listMailLog(db).filter((m) => m.typ === 'eskalation').length, 1);
  db.close();
});

test('POST /internal/cron/pool-erinnerungen does not mark a job sent when resolveEmpfaenger yields zero recipients, so a later sweep can still retry it', async () => {
  const { seedDefaults } = await import('../../src/db/adminConfigRepo.js');
  const { createJob, getJobById } = await import('../../src/db/jobsRepo.js');
  const { listMailLog } = await import('../../src/db/mailLogRepo.js');
  const db = openDatabase(':memory:');
  seedDefaults(db); // reminder_empfaenger/eskalation_empfaenger default to 'gruppe:buchhaltung'
  // Deliberately no persons seeded at all -> the buchhaltung group resolves to zero active
  // members, e.g. the window between first deployment boot and the first sync-personen run.
  const jobId = createJob(db, { eingangAm: '2020-01-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'alt.pdf', pdfPfad: '/tmp/a.pdf' });

  const config = { ...testConfig(), publicBaseUrl: 'https://portal.example.org' };
  const app = createApp({ db, config });

  const res1 = await request(app).post('/internal/cron/pool-erinnerungen').set('X-Cron-Secret', 'cron-secret');
  assert.equal(res1.status, 200);
  assert.equal(res1.body.reminder, 1);
  assert.equal(res1.body.eskalation, 1);
  assert.equal(listMailLog(db).length, 0, 'zero recipients resolved -> no mail attempts at all, nothing to log');
  const jobAfterFirstSweep = getJobById(db, jobId);
  assert.equal(jobAfterFirstSweep.reminder_gesendet_at, null, 'must not be marked sent when nobody was actually notified');
  assert.equal(jobAfterFirstSweep.eskalation_gesendet_at, null, 'must not be marked sent when nobody was actually notified');

  // A second sweep (simulating the next cron tick, still with no recipients configured) must
  // still pick the job up rather than having silently and permanently lost it.
  const res2 = await request(app).post('/internal/cron/pool-erinnerungen').set('X-Cron-Secret', 'cron-secret');
  assert.equal(res2.status, 200);
  assert.equal(res2.body.reminder, 1, 'still eligible for a retry on the next sweep');
  assert.equal(res2.body.eskalation, 1, 'still eligible for a retry on the next sweep');
  db.close();
});

test('POST /internal/cron/pool-erinnerungen returns a JSON error body (not an HTML error page) when the handler throws', async () => {
  const { seedDefaults, setConfigValue } = await import('../../src/db/adminConfigRepo.js');
  const { createJob } = await import('../../src/db/jobsRepo.js');
  const db = openDatabase(':memory:');
  seedDefaults(db);
  // A non-numeric reminder_stunden makes Number(...) yield NaN, which makes
  // listPoolJobsForReminder's `new Date(NaN).toISOString()` throw a RangeError inside the
  // handler's own try block -- a realistic misconfiguration (e.g. a corrupted admin_config row).
  setConfigValue(db, 'reminder_stunden', 'kaputt');
  createJob(db, { eingangAm: '2020-01-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'alt.pdf', pdfPfad: '/tmp/a.pdf' });
  const config = { ...testConfig(), publicBaseUrl: 'https://portal.example.org' };
  const app = createApp({ db, config });

  const res = await request(app).post('/internal/cron/pool-erinnerungen').set('X-Cron-Secret', 'cron-secret');
  assert.equal(res.status, 500);
  assert.equal(res.body.status, 'fehler');
  assert.equal(typeof res.body.error, 'string');
  assert.equal(res.type, 'application/json');
  db.close();
});

test('POST /internal/cron/pdf-bereinigung without the secret is rejected', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, config: testConfig() });
  const res = await request(app).post('/internal/cron/pdf-bereinigung');
  assert.equal(res.status, 401);
  db.close();
});

test('POST /internal/cron/pdf-bereinigung archives an abgeholt job once its PDF and thumbnail are deleted', async () => {
  const { mkdtempSync, rmSync, writeFileSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createJob, getJobById } = await import('../../src/db/jobsRepo.js');
  const { seedDefaults } = await import('../../src/db/adminConfigRepo.js');

  const dir = mkdtempSync(join(tmpdir(), 'pdf-bereinigung-test-'));
  const pdfPfad = join(dir, 'job.pdf');
  const thumbPfad = join(dir, 'job.png');
  writeFileSync(pdfPfad, 'pdf-bytes');
  writeFileSync(thumbPfad, 'png-bytes');

  const db = openDatabase(':memory:');
  seedDefaults(db);
  const jobId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad });
  db.prepare("UPDATE jobs SET status = 'abgeholt', thumbnail_pfad = ? WHERE id = ?").run(thumbPfad, jobId);

  const config = { ...testConfig(), jobsDir: dir };
  const app = createApp({ db, config });
  const res = await request(app).post('/internal/cron/pdf-bereinigung').set('X-Cron-Secret', 'cron-secret');

  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'erfolg');
  assert.equal(res.body.archiviert, 1);
  assert.equal(existsSync(pdfPfad), false);
  assert.equal(existsSync(thumbPfad), false);
  assert.equal(getJobById(db, jobId).status, 'archiviert');
  assert.ok(getJobById(db, jobId).archiviert_am);

  rmSync(dir, { recursive: true, force: true });
  db.close();
});

test('POST /internal/cron/pdf-bereinigung archives an abgeholt job immediately if its files are already gone (idempotent, covers pre-existing orphans)', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createJob, getJobById } = await import('../../src/db/jobsRepo.js');
  const { seedDefaults } = await import('../../src/db/adminConfigRepo.js');

  const dir = mkdtempSync(join(tmpdir(), 'pdf-bereinigung-gone-test-'));
  const db = openDatabase(':memory:');
  seedDefaults(db);
  // pdf_pfad points at a file that never existed on disk — simulates a pre-Batch-2 orphan
  // whose file was already deleted (or never written) by the time the sweep first runs.
  const jobId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: join(dir, 'missing.pdf') });
  db.prepare("UPDATE jobs SET status = 'abgeholt' WHERE id = ?").run(jobId);

  const config = { ...testConfig(), jobsDir: dir };
  const app = createApp({ db, config });
  const res = await request(app).post('/internal/cron/pdf-bereinigung').set('X-Cron-Secret', 'cron-secret');

  assert.equal(res.status, 200);
  assert.equal(res.body.archiviert, 1);
  assert.equal(getJobById(db, jobId).status, 'archiviert');

  rmSync(dir, { recursive: true, force: true });
  db.close();
});

test('POST /internal/cron/pdf-bereinigung never touches an abgelehnt job', async () => {
  const { mkdtempSync, rmSync, writeFileSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createJob, getJobById } = await import('../../src/db/jobsRepo.js');
  const { seedDefaults } = await import('../../src/db/adminConfigRepo.js');

  const dir = mkdtempSync(join(tmpdir(), 'pdf-bereinigung-abgelehnt-test-'));
  const pdfPfad = join(dir, 'job.pdf');
  writeFileSync(pdfPfad, 'pdf-bytes');

  const db = openDatabase(':memory:');
  seedDefaults(db);
  const jobId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad });
  db.prepare("UPDATE jobs SET status = 'abgelehnt' WHERE id = ?").run(jobId);

  const config = { ...testConfig(), jobsDir: dir };
  const app = createApp({ db, config });
  const res = await request(app).post('/internal/cron/pdf-bereinigung').set('X-Cron-Secret', 'cron-secret');

  assert.equal(res.status, 200);
  assert.equal(res.body.archiviert, 0);
  assert.equal(existsSync(pdfPfad), true);
  assert.equal(getJobById(db, jobId).status, 'abgelehnt');

  rmSync(dir, { recursive: true, force: true });
  db.close();
});

test('POST /internal/cron/pdf-bereinigung never archives a job while its PDF still exists on disk', async () => {
  const { mkdtempSync, rmSync, mkdirSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createJob, getJobById } = await import('../../src/db/jobsRepo.js');
  const { seedDefaults } = await import('../../src/db/adminConfigRepo.js');

  const dir = mkdtempSync(join(tmpdir(), 'pdf-bereinigung-guard-test-'));
  // pdf_pfad points at a directory, not a file. unlinkSync() on a directory always throws
  // EISDIR/EPERM on every platform and every user (including root, unlike a chmod-based
  // permission-denial test, which root silently ignores) — a deterministic way to force the
  // sweep's delete step to fail without relying on filesystem permissions.
  const pdfPfad = join(dir, 'job-is-actually-a-dir.pdf');
  mkdirSync(pdfPfad);

  const db = openDatabase(':memory:');
  seedDefaults(db);
  const jobId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad });
  db.prepare("UPDATE jobs SET status = 'abgeholt' WHERE id = ?").run(jobId);

  const config = { ...testConfig(), jobsDir: dir };
  const app = createApp({ db, config });
  const res = await request(app).post('/internal/cron/pdf-bereinigung').set('X-Cron-Secret', 'cron-secret');

  assert.equal(res.status, 200);
  assert.equal(res.body.archiviert, 0, 'the job must NOT be archived while its PDF still exists on disk');
  assert.equal(getJobById(db, jobId).status, 'abgeholt');
  assert.equal(existsSync(pdfPfad), true, 'the delete attempt failed, so the file must still be there');

  rmSync(dir, { recursive: true, force: true });
  db.close();
});

test('POST /internal/cron/pdf-bereinigung deletes .tmp files older than 1 hour but leaves recent ones', async () => {
  const { mkdtempSync, rmSync, writeFileSync, existsSync, utimesSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { seedDefaults } = await import('../../src/db/adminConfigRepo.js');

  const dir = mkdtempSync(join(tmpdir(), 'pdf-bereinigung-tmp-test-'));
  const oldTmp = join(dir, 'job-1.pdf.old-uuid.tmp');
  const freshTmp = join(dir, 'job-2.pdf.fresh-uuid.tmp');
  writeFileSync(oldTmp, 'stale-stamped-pdf');
  writeFileSync(freshTmp, 'fresh-stamped-pdf');
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  utimesSync(oldTmp, twoHoursAgo, twoHoursAgo);

  const db = openDatabase(':memory:');
  seedDefaults(db);
  const config = { ...testConfig(), jobsDir: dir };
  const app = createApp({ db, config });
  const res = await request(app).post('/internal/cron/pdf-bereinigung').set('X-Cron-Secret', 'cron-secret');

  assert.equal(res.status, 200);
  assert.equal(res.body.tmpGeloescht, 1);
  assert.equal(existsSync(oldTmp), false);
  assert.equal(existsSync(freshTmp), true);

  rmSync(dir, { recursive: true, force: true });
  db.close();
});

test('POST /internal/cron/pdf-bereinigung prunes mail_log rows older than mail_log_aufbewahrung_tage', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { seedDefaults, setConfigValue } = await import('../../src/db/adminConfigRepo.js');
  const { logMailAttempt, listMailLog } = await import('../../src/db/mailLogRepo.js');

  const dir = mkdtempSync(join(tmpdir(), 'pdf-bereinigung-maillog-test-'));
  const db = openDatabase(':memory:');
  seedDefaults(db);
  setConfigValue(db, 'mail_log_aufbewahrung_tage', '30');
  const oldId = logMailAttempt(db, { typ: 'reminder', jobId: null, empfaenger: 'old@example.org', betreff: 'B', text: 'T', status: 'versendet' });
  db.prepare('UPDATE mail_log SET versucht_am = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', oldId);
  logMailAttempt(db, { typ: 'reminder', jobId: null, empfaenger: 'new@example.org', betreff: 'B', text: 'T', status: 'versendet' });

  const config = { ...testConfig(), jobsDir: dir };
  const app = createApp({ db, config });
  const res = await request(app).post('/internal/cron/pdf-bereinigung').set('X-Cron-Secret', 'cron-secret');

  assert.equal(res.status, 200);
  assert.equal(res.body.mailLogGeloescht, 1);
  assert.equal(listMailLog(db).length, 1);
  assert.equal(listMailLog(db)[0].empfaenger, 'new@example.org');

  rmSync(dir, { recursive: true, force: true });
  db.close();
});

test('POST /internal/cron/pdf-bereinigung is idempotent: a second run with nothing new to do reports all zeros', async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createJob } = await import('../../src/db/jobsRepo.js');
  const { seedDefaults } = await import('../../src/db/adminConfigRepo.js');

  const dir = mkdtempSync(join(tmpdir(), 'pdf-bereinigung-idempotent-test-'));
  const pdfPfad = join(dir, 'job.pdf');
  writeFileSync(pdfPfad, 'pdf-bytes');

  const db = openDatabase(':memory:');
  seedDefaults(db);
  const jobId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad });
  db.prepare("UPDATE jobs SET status = 'abgeholt' WHERE id = ?").run(jobId);

  const config = { ...testConfig(), jobsDir: dir };
  const app = createApp({ db, config });

  const res1 = await request(app).post('/internal/cron/pdf-bereinigung').set('X-Cron-Secret', 'cron-secret');
  assert.equal(res1.body.archiviert, 1);

  const res2 = await request(app).post('/internal/cron/pdf-bereinigung').set('X-Cron-Secret', 'cron-secret');
  assert.equal(res2.status, 200);
  assert.equal(res2.body.archiviert, 0);
  assert.equal(res2.body.tmpGeloescht, 0);
  assert.equal(res2.body.mailLogGeloescht, 0);

  rmSync(dir, { recursive: true, force: true });
  db.close();
});

test('POST /internal/cron/pdf-bereinigung still returns 200 with the normal success shape when the mail_log prune step fails, reporting the other sweeps that already completed', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { seedDefaults, setConfigValue } = await import('../../src/db/adminConfigRepo.js');

  const dir = mkdtempSync(join(tmpdir(), 'pdf-bereinigung-maillog-fehler-test-'));
  const db = openDatabase(':memory:');
  seedDefaults(db);
  // A non-numeric mail_log_aufbewahrung_tage makes Number(...) yield NaN, which makes
  // new Date(NaN).toISOString() throw a RangeError inside the mail_log prune block --
  // a realistic misconfiguration (e.g. a corrupted admin_config row).
  setConfigValue(db, 'mail_log_aufbewahrung_tage', 'not-a-number');

  const config = { ...testConfig(), jobsDir: dir };
  const app = createApp({ db, config });
  const res = await request(app).post('/internal/cron/pdf-bereinigung').set('X-Cron-Secret', 'cron-secret');

  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'erfolg');
  assert.equal(res.body.mailLogGeloescht, 0);

  rmSync(dir, { recursive: true, force: true });
  db.close();
});
