import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createJob } from '../../src/db/jobsRepo.js';
import { createFreigabe } from '../../src/db/freigabenRepo.js';
import { setConfigValue } from '../../src/db/adminConfigRepo.js';
import { buildAuditLog, EREIGNIS_LABEL, personName, formatZeitpunkt } from '../../src/services/auditLog.js';

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

test('buildAuditLog labels an iban_abweichung rolle as "IBAN-Abweichung festgestellt"', () => {
  const db = openDatabase(':memory:');
  const jobId = seedJobMitFreigabe(db, '2026-08-22T08:30:00.000Z');
  createFreigabe(db, { jobId, personId: '1', rolle: 'iban_abweichung', zeitpunkt: '2026-08-22T09:00:00.000Z', ip: '127.0.0.1', interessenskonflikt: false, kommentar: 'QR-IBAN weicht ab', eskaliertVon: null });
  const log = buildAuditLog(db, jobId);
  assert.equal(log[1].ereignis, 'IBAN-Abweichung festgestellt');
  assert.equal(log[1].kommentar, 'QR-IBAN weicht ab');
  db.close();
});

test('EREIGNIS_LABEL includes a loeschung label for the global audit log', () => {
  assert.equal(EREIGNIS_LABEL.loeschung, 'Job gelöscht');
});

test('buildAuditLog labels a rechnungsnummer_duplikat rolle as "Doppelte Rechnungsnummer festgestellt"', () => {
  const db = openDatabase(':memory:');
  const jobId = seedJobMitFreigabe(db, '2026-08-31T08:30:00.000Z');
  createFreigabe(db, { jobId, personId: '1', rolle: 'rechnungsnummer_duplikat', zeitpunkt: '2026-08-31T09:00:00.000Z', ip: '127.0.0.1', interessenskonflikt: false, kommentar: 'Rechnungsnummer bereits erfasst', eskaliertVon: null });
  const log = buildAuditLog(db, jobId);
  assert.equal(log[1].ereignis, 'Doppelte Rechnungsnummer festgestellt');
  assert.equal(log[1].kommentar, 'Rechnungsnummer bereits erfasst');
  db.close();
});

test('personName and formatZeitpunkt are exported for reuse by the global audit log service', () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'Frei', nachname: 'Geber', email: 'f@example.org', gruppen: [], loggedInNow: false });
  assert.equal(personName(db, '1'), 'Frei Geber');
  assert.equal(personName(db, 'unbekannt'), 'Unbekannt');
  assert.equal(formatZeitpunkt('2026-08-15T08:30:00.000Z', false), '2026-08-15T08:30:00.000Z');
  db.close();
});

test('buildAuditLog resolves vertretungFuerPerson to a display name when vertretung_fuer is set', () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'Ana', nachname: 'Muster', email: 'ana@example.org', gruppen: ['10'], loggedInNow: true });
  upsertPerson(db, { id: '2', vorname: 'Bo', nachname: 'Muster', email: 'bo@example.org', gruppen: ['10'], loggedInNow: true });
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  createFreigabe(db, {
    jobId, personId: '2', rolle: 'freigeber1', zeitpunkt: '2026-09-07T10:00:00.000Z', ip: '127.0.0.1',
    interessenskonflikt: false, kommentar: null, eskaliertVon: null, vertretungFuer: '1',
  });

  const [eintrag] = buildAuditLog(db, jobId);
  assert.equal(eintrag.vertretungFuerPerson, 'Ana Muster');
  db.close();
});

test('buildAuditLog leaves vertretungFuerPerson null when vertretung_fuer is not set', () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '2', vorname: 'Bo', nachname: 'Muster', email: 'bo@example.org', gruppen: ['10'], loggedInNow: true });
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  createFreigabe(db, {
    jobId, personId: '2', rolle: 'freigeber1', zeitpunkt: '2026-09-07T10:00:00.000Z', ip: '127.0.0.1',
    interessenskonflikt: false, kommentar: null, eskaliertVon: null,
  });

  const [eintrag] = buildAuditLog(db, jobId);
  assert.equal(eintrag.vertretungFuerPerson, null);
  db.close();
});
