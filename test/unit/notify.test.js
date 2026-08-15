import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { createJob } from '../../src/db/jobsRepo.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { listMailLog } from '../../src/db/mailLogRepo.js';
import { sendNotification, resolveEmpfaenger } from '../../src/services/notify.js';

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

test('sendNotification logs a versendet row on success and calls the mailer with the right fields', async () => {
  const db = openDatabase(':memory:');
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  const mailer = createStubMailer();
  await sendNotification(db, mailer, { to: 'x@example.org', subject: 'Betreff', text: 'Text', typ: 'zuweisung', jobId });

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

test('sendNotification logs a fehlgeschlagen row on failure and never throws', async () => {
  const db = openDatabase(':memory:');
  const mailer = createStubMailer({ shouldFail: true });
  await assert.doesNotReject(() =>
    sendNotification(db, mailer, { to: 'x@example.org', subject: 'B', text: 'T', typ: 'reminder', jobId: null })
  );
  const rows = listMailLog(db);
  assert.equal(rows[0].status, 'fehlgeschlagen');
  assert.equal(rows[0].fehler_details, 'SMTP-Testfehler');
  db.close();
});

test('sendNotification degrades gracefully when mailer is undefined, for routers that have not been updated to pass one', async () => {
  const db = openDatabase(':memory:');
  await assert.doesNotReject(() =>
    sendNotification(db, undefined, { to: 'x@example.org', subject: 'B', text: 'T', typ: 'reminder', jobId: null })
  );
  const rows = listMailLog(db);
  assert.equal(rows[0].status, 'fehlgeschlagen');
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
