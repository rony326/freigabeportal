import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { createJob } from '../../src/db/jobsRepo.js';
import { logMailAttempt, listMailLog, getMailLogById } from '../../src/db/mailLogRepo.js';

test('logMailAttempt inserts a versendet row with all fields, getMailLogById returns it', () => {
  const db = openDatabase(':memory:');
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  const id = logMailAttempt(db, { typ: 'zuweisung', jobId, empfaenger: 'x@example.org', betreff: 'Betreff', text: 'Text', status: 'versendet' });
  assert.equal(typeof id, 'number');
  const row = getMailLogById(db, id);
  assert.equal(row.typ, 'zuweisung');
  assert.equal(row.job_id, jobId);
  assert.equal(row.empfaenger, 'x@example.org');
  assert.equal(row.betreff, 'Betreff');
  assert.equal(row.text, 'Text');
  assert.equal(row.status, 'versendet');
  assert.equal(row.fehler_details, null);
  assert.ok(row.versucht_am);
  db.close();
});

test('logMailAttempt records fehlgeschlagen with fehler_details', () => {
  const db = openDatabase(':memory:');
  logMailAttempt(db, { typ: 'reminder', jobId: null, empfaenger: 'x@example.org', betreff: 'B', text: 'T', status: 'fehlgeschlagen', fehlerDetails: 'SMTP-Fehler' });
  const rows = listMailLog(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'fehlgeschlagen');
  assert.equal(rows[0].fehler_details, 'SMTP-Fehler');
  assert.equal(rows[0].job_id, null);
  db.close();
});

test('listMailLog returns rows newest first', () => {
  const db = openDatabase(':memory:');
  const id1 = logMailAttempt(db, { typ: 'reminder', jobId: null, empfaenger: 'a@example.org', betreff: 'B1', text: 'T1', status: 'versendet' });
  const id2 = logMailAttempt(db, { typ: 'reminder', jobId: null, empfaenger: 'b@example.org', betreff: 'B2', text: 'T2', status: 'versendet' });
  const rows = listMailLog(db);
  assert.equal(rows[0].id, id2);
  assert.equal(rows[1].id, id1);
  db.close();
});

test('getMailLogById returns null for an unknown id', () => {
  const db = openDatabase(':memory:');
  assert.equal(getMailLogById(db, 999), null);
  db.close();
});
