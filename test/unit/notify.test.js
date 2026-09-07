import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { createJob } from '../../src/db/jobsRepo.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { listMailLog } from '../../src/db/mailLogRepo.js';
import { sendNotification, sendRenderedMail, resolveEmpfaenger } from '../../src/services/notify.js';
import { setConfigValue, seedDefaults } from '../../src/db/adminConfigRepo.js';

function createStubMailer({ shouldFail = false } = {}) {
  const sent = [];
  return {
    sent,
    async sendMail(mail) {
      sent.push(mail);
      if (shouldFail) throw new Error('SMTP-Testfehler');
    },
  };
}

test('sendRenderedMail logs a versendet row on success and calls the mailer with the right fields', async () => {
  const db = openDatabase(':memory:');
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  const mailer = createStubMailer();
  await sendRenderedMail(db, mailer, { to: 'x@example.org', subject: 'Betreff', text: 'Text', typ: 'zuweisung', jobId });

  assert.equal(mailer.sent.length, 1);
  assert.equal(mailer.sent[0].to, 'x@example.org');
  assert.equal(mailer.sent[0].subject, 'Betreff');
  assert.equal(mailer.sent[0].text, 'Text');

  const rows = listMailLog(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'versendet');
  assert.equal(rows[0].typ, 'zuweisung');
  assert.equal(rows[0].job_id, jobId);
  db.close();
});

test('sendRenderedMail logs a fehlgeschlagen row on failure and never throws', async () => {
  const db = openDatabase(':memory:');
  const mailer = createStubMailer({ shouldFail: true });
  await assert.doesNotReject(() =>
    sendRenderedMail(db, mailer, { to: 'x@example.org', subject: 'B', text: 'T', typ: 'reminder', jobId: null })
  );
  const rows = listMailLog(db);
  assert.equal(rows[0].status, 'fehlgeschlagen');
  assert.equal(rows[0].fehler_details, 'SMTP-Testfehler');
  db.close();
});

test('sendRenderedMail degrades gracefully when mailer is undefined', async () => {
  const db = openDatabase(':memory:');
  await assert.doesNotReject(() =>
    sendRenderedMail(db, undefined, { to: 'x@example.org', subject: 'B', text: 'T', typ: 'reminder', jobId: null })
  );
  const rows = listMailLog(db);
  assert.equal(rows[0].status, 'fehlgeschlagen');
  db.close();
});

test('sendNotification renders the configured template and sends immediately when batching is off', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  const mailer = createStubMailer();
  await sendNotification(db, mailer, {
    to: 'x@example.org',
    typ: 'zuweisung',
    jobId,
    variablen: { empfaengerName: 'Erika Muster', jobDateiname: 'a.pdf', grund: 'Dir wurde eine neue Rechnung zugewiesen.', link: 'http://portal.example.org/kontierung/1' },
  });

  assert.equal(mailer.sent.length, 1);
  assert.equal(mailer.sent[0].subject, 'Freigabeportal: Neue Rechnung zur Bearbeitung');
  assert.match(mailer.sent[0].text, /Erika Muster/);
  assert.match(mailer.sent[0].text, /Dir wurde eine neue Rechnung zugewiesen\./);

  const rows = listMailLog(db);
  assert.equal(rows[0].status, 'versendet');
  assert.equal(rows[0].typ, 'zuweisung');
  db.close();
});

test('sendNotification queues a geplant row instead of sending when batching is active', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  setConfigValue(db, 'mail_batching_aktiv', '1');
  const mailer = createStubMailer();
  await sendNotification(db, mailer, {
    to: 'x@example.org',
    typ: 'zuweisung',
    jobId: null,
    variablen: { empfaengerName: 'Erika Muster', jobDateiname: 'a.pdf', grund: 'G', link: 'L' },
  });

  assert.equal(mailer.sent.length, 0, 'no SMTP call while queued');
  const rows = listMailLog(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'geplant');
  assert.equal(rows[0].empfaenger, 'x@example.org');
  assert.match(rows[0].text, /Erika Muster/, 'the row already holds the fully-rendered text');
  db.close();
});

test('sendNotification ignores the batching switch for sync-fehler and always sends immediately', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  setConfigValue(db, 'mail_batching_aktiv', '1');
  const mailer = createStubMailer();
  await sendNotification(db, mailer, {
    to: 'a@example.org',
    typ: 'sync-fehler',
    jobId: null,
    variablen: { fehlerDetails: 'Boom', zeitpunkt: '2026-09-07T10:00:00.000Z', link: 'http://portal.example.org/admin/sync' },
  });
  assert.equal(mailer.sent.length, 1);
  assert.equal(listMailLog(db)[0].status, 'versendet');
  db.close();
});

test('sendNotification ignores the batching switch for iban-warnung and always sends immediately', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  setConfigValue(db, 'mail_batching_aktiv', '1');
  const mailer = createStubMailer();
  await sendNotification(db, mailer, {
    to: 'a@example.org',
    typ: 'iban-warnung',
    jobId: null,
    variablen: { jobDateiname: 'a.pdf', debitorName: 'ACME', tatsaechlicheIban: 'CH00', link: 'L' },
  });
  assert.equal(mailer.sent.length, 1);
  assert.equal(listMailLog(db)[0].status, 'versendet');
  db.close();
});

test('sendNotification never throws and logs a fehlgeschlagen row when the requested typ\'s template is missing (unrenderable)', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  // Simulate a missing admin_config key (e.g. a corrupted/partial config) rather than passing
  // null through setConfigValue -- the admin_config.value column is NOT NULL, so the only
  // realistic way to reproduce "getConfigValue returns null for this one key" is to never have
  // set it (or to remove it) while every other key sendNotification touches stays intact.
  db.prepare("DELETE FROM admin_config WHERE key = 'mail_vorlage_zuweisung_text'").run();
  const mailer = createStubMailer();

  await assert.doesNotReject(() =>
    sendNotification(db, mailer, {
      to: 'x@example.org',
      typ: 'zuweisung',
      jobId: null,
      variablen: { empfaengerName: 'Erika Muster', jobDateiname: 'a.pdf', grund: 'G', link: 'L' },
    })
  );

  assert.equal(mailer.sent.length, 0, 'no SMTP call must happen when the template could not be rendered');
  const rows = listMailLog(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'fehlgeschlagen');
  assert.equal(rows[0].typ, 'zuweisung');
  assert.ok(rows[0].fehler_details);
  db.close();
});

test('sendNotification never throws when the requested typ is unknown, even though mail_log cannot log a typ its CHECK constraint disallows', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  const mailer = createStubMailer();

  // 'unbekannter-typ' makes getVorlage() throw (unknown template) AND makes the subsequent
  // logMailAttempt() itself throw (mail_log.typ has a CHECK constraint listing only the real
  // typs) -- this exercises the nested try/catch around that logging call, not just the outer one.
  await assert.doesNotReject(() =>
    sendNotification(db, mailer, { to: 'x@example.org', typ: 'unbekannter-typ', jobId: null, variablen: {} })
  );

  assert.equal(mailer.sent.length, 0, 'no SMTP call must happen for an unknown typ');
  db.close();
});

test('resolveEmpfaenger returns an empty array for a null/empty config value', () => {
  const db = openDatabase(':memory:');
  const config = { churchtools: { groupIdBuchhaltung: '10' } };
  assert.deepEqual(resolveEmpfaenger(db, config, null), []);
  assert.deepEqual(resolveEmpfaenger(db, config, ''), []);
  db.close();
});

test('resolveEmpfaenger expands gruppe:buchhaltung to every active group member and keeps literal addresses', () => {
  const db = openDatabase(':memory:');
  const config = { churchtools: { groupIdBuchhaltung: '10' } };
  upsertPerson(db, { id: '1', vorname: 'A', nachname: 'B', email: 'a@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '2', vorname: 'C', nachname: 'D', email: 'c@example.org', gruppen: ['20'], loggedInNow: false });

  const result = resolveEmpfaenger(db, config, 'gruppe:buchhaltung\nmanuell@example.org');
  assert.equal(result.length, 2);
  assert.ok(result.includes('a@example.org'));
  assert.ok(result.includes('manuell@example.org'));
  assert.ok(!result.includes('c@example.org'));
  db.close();
});

test('resolveEmpfaenger deduplicates when a manual address matches a resolved group member', () => {
  const db = openDatabase(':memory:');
  const config = { churchtools: { groupIdBuchhaltung: '10' } };
  upsertPerson(db, { id: '1', vorname: 'A', nachname: 'B', email: 'a@example.org', gruppen: ['10'], loggedInNow: false });

  const result = resolveEmpfaenger(db, config, 'gruppe:buchhaltung\na@example.org');
  assert.equal(result.length, 1);
  db.close();
});

test('resolveEmpfaenger ignores blank lines', () => {
  const db = openDatabase(':memory:');
  const config = { churchtools: { groupIdBuchhaltung: '10' } };
  const result = resolveEmpfaenger(db, config, '\n\nx@example.org\n\n');
  assert.deepEqual(result, ['x@example.org']);
  db.close();
});

test('resolveEmpfaenger resolves "gruppe:admin" to the email addresses of active Portal-Admin group members', () => {
  const db = openDatabase(':memory:');
  const CONFIG = { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20' } };
  upsertPerson(db, { id: '1', vorname: 'Admina', nachname: 'Eins', email: 'admin1@example.org', gruppen: ['20'], loggedInNow: false });
  upsertPerson(db, { id: '2', vorname: 'Nur', nachname: 'Buchhaltung', email: 'buch@example.org', gruppen: ['10'], loggedInNow: false });

  const empfaenger = resolveEmpfaenger(db, CONFIG, 'gruppe:admin');
  assert.deepEqual(empfaenger, ['admin1@example.org']);
  db.close();
});

test('resolveEmpfaenger still resolves "gruppe:buchhaltung" and plain email lines as before', () => {
  const db = openDatabase(':memory:');
  const CONFIG = { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20' } };
  upsertPerson(db, { id: '1', vorname: 'Buch', nachname: 'Halter', email: 'buch@example.org', gruppen: ['10'], loggedInNow: false });

  const empfaenger = resolveEmpfaenger(db, CONFIG, 'gruppe:buchhaltung\nextra@example.org');
  assert.deepEqual(new Set(empfaenger), new Set(['buch@example.org', 'extra@example.org']));
  db.close();
});

test('resolveEmpfaenger returns an empty array for an empty config value', () => {
  const db = openDatabase(':memory:');
  const CONFIG = { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20' } };
  assert.deepEqual(resolveEmpfaenger(db, CONFIG, ''), []);
  assert.deepEqual(resolveEmpfaenger(db, CONFIG, null), []);
  db.close();
});
