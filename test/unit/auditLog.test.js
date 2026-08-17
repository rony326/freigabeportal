import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createJob } from '../../src/db/jobsRepo.js';
import { createFreigabe } from '../../src/db/freigabenRepo.js';
import { setConfigValue } from '../../src/db/adminConfigRepo.js';
import { buildAuditLog } from '../../src/services/auditLog.js';

function seedJobMitFreigabe(db, zeitpunkt) {
  upsertPerson(db, { id: '1', vorname: 'Frei', nachname: 'Geber', email: 'f@example.org', gruppen: [], loggedInNow: false });
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  createFreigabe(db, { jobId, personId: '1', rolle: 'freigeber1', zeitpunkt, ip: '127.0.0.1', interessenskonflikt: false, kommentar: null, eskaliertVon: null });
  return jobId;
}

test('buildAuditLog returns the raw UTC ISO timestamp by default (audit_log_lokale_zeit unset)', () => {
  const db = openDatabase(':memory:');
  const jobId = seedJobMitFreigabe(db, '2026-08-15T08:30:00.000Z');
  const log = buildAuditLog(db, jobId);
  assert.equal(log.length, 1);
  assert.equal(log[0].zeitpunkt, '2026-08-15T08:30:00.000Z');
  db.close();
});

test('buildAuditLog keeps the raw UTC ISO timestamp when audit_log_lokale_zeit is explicitly "0"', () => {
  const db = openDatabase(':memory:');
  setConfigValue(db, 'audit_log_lokale_zeit', '0');
  const jobId = seedJobMitFreigabe(db, '2026-08-15T08:30:00.000Z');
  const log = buildAuditLog(db, jobId);
  assert.equal(log[0].zeitpunkt, '2026-08-15T08:30:00.000Z');
  db.close();
});

test('buildAuditLog formats the timestamp as Europe/Zurich local time (CEST, summer) when audit_log_lokale_zeit is "1"', () => {
  const db = openDatabase(':memory:');
  setConfigValue(db, 'audit_log_lokale_zeit', '1');
  // 2026-08-15T08:30:00Z is during CEST (UTC+2) -> 10:30 local.
  const jobId = seedJobMitFreigabe(db, '2026-08-15T08:30:00.000Z');
  const log = buildAuditLog(db, jobId);
  assert.equal(log[0].zeitpunkt, '15.08.2026 10:30');
  db.close();
});

test('buildAuditLog formats the timestamp as Europe/Zurich local time (CET, winter) when audit_log_lokale_zeit is "1"', () => {
  const db = openDatabase(':memory:');
  setConfigValue(db, 'audit_log_lokale_zeit', '1');
  // 2026-01-15T08:30:00Z is during CET (UTC+1) -> 09:30 local.
  const jobId = seedJobMitFreigabe(db, '2026-01-15T08:30:00.000Z');
  const log = buildAuditLog(db, jobId);
  assert.equal(log[0].zeitpunkt, '15.01.2026 09:30');
  db.close();
});
