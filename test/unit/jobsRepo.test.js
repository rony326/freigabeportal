import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createKonto, deactivateKonto } from '../../src/db/kontenRepo.js';
import { createZuweisungsregel } from '../../src/db/zuweisungsregelnRepo.js';
import { findMatchingZuweisungsregel, createJob, getJobById, listPoolJobs, claimJob, listAbholbereitJobs, confirmAbholung, setThumbnailPfad, setKontierung, eskalierenFreigabe1, abschliessenFreigabe1, eskalierenFreigabe2, abschliessenFreigabe2, releaseJob, listZugewiesenJobsForPerson, listFreigabe2JobsForPerson, getEffectiveFreigeber2Id, ablehnenJob, wiederOeffnenJob, listAbgelehntJobsForPerson, listPoolJobsForReminder, markReminderGesendet, listPoolJobsForEskalation, markEskalationGesendet, listAbgeholtJobs, archivierenJob, eskalierenFreigabe1AnAdmin, eskalierenFreigabe2AnAdmin, listStalledJobs, forceReleaseJob, forceEskalierenFreigabe2AnAdmin } from '../../src/db/jobsRepo.js';

function seedKonto(db) {
  for (const id of ['1', '2', '3', '4']) {
    upsertPerson(db, { id, vorname: `Person${id}`, nachname: 'Muster', email: `p${id}@example.org`, gruppen: ['10'], loggedInNow: false });
  }
  return createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
}

test('findMatchingZuweisungsregel: exact email address matches', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  createZuweisungsregel(db, { absenderMuster: 'rechnungen@lieferant.ch', kontoId });
  const regel = findMatchingZuweisungsregel(db, 'rechnungen@lieferant.ch');
  assert.equal(regel.konto_id, kontoId);
  db.close();
});

test('findMatchingZuweisungsregel: domain pattern matches a subdomain sender', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  createZuweisungsregel(db, { absenderMuster: 'lieferant.ch', kontoId });
  const regel = findMatchingZuweisungsregel(db, 'rechnungen@sub.lieferant.ch');
  assert.equal(regel.konto_id, kontoId);
  db.close();
});

test('findMatchingZuweisungsregel: domain pattern does not match an unrelated domain sharing a suffix', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  createZuweisungsregel(db, { absenderMuster: 'lieferant.ch', kontoId });
  assert.equal(findMatchingZuweisungsregel(db, 'rechnungen@notlieferant.ch'), null);
  db.close();
});

test('findMatchingZuweisungsregel: exact address wins over a domain rule that would also match', () => {
  const db = openDatabase(':memory:');
  const kontoId1 = seedKonto(db);
  upsertPerson(db, { id: '5', vorname: 'P5', nachname: 'Muster', email: 'p5@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '6', vorname: 'P6', nachname: 'Muster', email: 'p6@example.org', gruppen: ['10'], loggedInNow: false });
  const kontoId2 = createKonto(db, { kontonummer: '3001', bezeichnung: 'Spezial', freigeber1Id: '5', stellvertreter1Id: '6', freigeber2Id: '1', stellvertreter2Id: '2' });
  createZuweisungsregel(db, { absenderMuster: 'lieferant.ch', kontoId: kontoId1 });
  createZuweisungsregel(db, { absenderMuster: 'rechnungen@lieferant.ch', kontoId: kontoId2 });
  const regel = findMatchingZuweisungsregel(db, 'rechnungen@lieferant.ch');
  assert.equal(regel.konto_id, kontoId2);
  db.close();
});

test('findMatchingZuweisungsregel: returns null without a sender or without any match', () => {
  const db = openDatabase(':memory:');
  seedKonto(db);
  assert.equal(findMatchingZuweisungsregel(db, null), null);
  assert.equal(findMatchingZuweisungsregel(db, 'unbekannt@anderswo.ch'), null);
  db.close();
});

test('findMatchingZuweisungsregel: a display-name-plus-bracket sender still matches on the bracketed address', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  createZuweisungsregel(db, { absenderMuster: 'lieferant.ch', kontoId });
  const regel = findMatchingZuweisungsregel(db, '"Lieferant AG" <rechnung@lieferant.ch>');
  assert.equal(regel.konto_id, kontoId);
  db.close();
});

test('findMatchingZuweisungsregel: a comma-separated multi-address sender with no brackets matches nothing (refuses to guess)', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  createZuweisungsregel(db, { absenderMuster: 'lieferant.ch', kontoId });
  // Naive lastIndexOf('@') parsing would have matched "lieferant.ch" here, letting an attacker
  // steer an invoice to a chosen Konto/approver by appending a trailing legitimate-looking
  // address after their own.
  assert.equal(findMatchingZuweisungsregel(db, 'billing@attacker.example, buchhaltung@lieferant.ch'), null);
  db.close();
});

test('findMatchingZuweisungsregel: a multi-address sender where the legitimate address is bracketed still matches nothing', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  createZuweisungsregel(db, { absenderMuster: 'lieferant.ch', kontoId });
  // Extracting only the last "<...>" without checking what precedes it would have let an
  // attacker recover the bracket-extraction bypass: prepend their own address before the
  // legitimate-looking bracketed one.
  assert.equal(findMatchingZuweisungsregel(db, 'billing@attacker.example, <buchhaltung@lieferant.ch>'), null);
  assert.equal(findMatchingZuweisungsregel(db, 'billing@attacker.example <buchhaltung@lieferant.ch>'), null);
  assert.equal(findMatchingZuweisungsregel(db, 'a@evil.com <x@y.ch>, b@c.ch <rechnung@lieferant.ch>'), null);
  db.close();
});

test('findMatchingZuweisungsregel: a malformed sender with no "@" at all matches nothing', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  createZuweisungsregel(db, { absenderMuster: 'lieferant.ch', kontoId });
  assert.equal(findMatchingZuweisungsregel(db, 'not-an-email-address'), null);
  db.close();
});

test('createJob auto-assigns via a matching Zuweisungsregel', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  createZuweisungsregel(db, { absenderMuster: 'lieferant.ch', kontoId });
  const id = createJob(db, { eingangAm: '2026-08-14T10:00:00.000Z', quelle: 'lieferant', absender: 'rechnungen@lieferant.ch', dateiname: 'rechnung.pdf', pdfPfad: '/tmp/x.pdf' });
  const job = getJobById(db, id);
  assert.equal(job.status, 'zugewiesen');
  assert.equal(job.konto_id, kontoId);
  assert.equal(job.zugewiesen_an, '1');
  db.close();
});

test('createJob leaves a job unzugewiesen when no Zuweisungsregel matches', () => {
  const db = openDatabase(':memory:');
  seedKonto(db);
  const id = createJob(db, { eingangAm: '2026-08-14T10:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'scan.pdf', pdfPfad: '/tmp/y.pdf' });
  const job = getJobById(db, id);
  assert.equal(job.status, 'unzugewiesen');
  assert.equal(job.konto_id, null);
  assert.equal(job.zugewiesen_an, null);
  db.close();
});

test('createJob falls back to the pool when the matched Konto is inactive', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  createZuweisungsregel(db, { absenderMuster: 'lieferant.ch', kontoId });
  deactivateKonto(db, kontoId);
  const id = createJob(db, { eingangAm: '2026-08-14T10:00:00.000Z', quelle: 'lieferant', absender: 'rechnungen@lieferant.ch', dateiname: 'rechnung.pdf', pdfPfad: '/tmp/z.pdf' });
  const job = getJobById(db, id);
  assert.equal(job.status, 'unzugewiesen');
  assert.equal(job.konto_id, null);
  db.close();
});

test('getJobById returns null for an unknown id', () => {
  const db = openDatabase(':memory:');
  assert.equal(getJobById(db, 999), null);
  db.close();
});

test('listPoolJobs returns only unzugewiesen jobs', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const poolId = createJob(db, { eingangAm: '2026-08-14T10:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  createZuweisungsregel(db, { absenderMuster: 'lieferant.ch', kontoId });
  createJob(db, { eingangAm: '2026-08-14T10:00:00.000Z', quelle: 'lieferant', absender: 'rechnungen@lieferant.ch', dateiname: 'b.pdf', pdfPfad: '/tmp/b.pdf' });
  const jobs = listPoolJobs(db);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].id, poolId);
  db.close();
});

test('claimJob atomically assigns an unzugewiesen job and rejects a second claim', () => {
  const db = openDatabase(':memory:');
  seedKonto(db);
  const id = createJob(db, { eingangAm: '2026-08-14T10:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  const firstClaim = claimJob(db, id, '1');
  const secondClaim = claimJob(db, id, '2');
  assert.equal(firstClaim, true);
  assert.equal(secondClaim, false);
  const job = getJobById(db, id);
  assert.equal(job.status, 'zugewiesen');
  assert.equal(job.zugewiesen_an, '1');
  db.close();
});

function seedAbgeschlossenJob(db) {
  const kontoId = seedKonto(db);
  const id = createJob(db, { eingangAm: '2026-08-14T10:00:00.000Z', quelle: 'lieferant', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare("UPDATE jobs SET status = 'abgeschlossen', konto_id = ? WHERE id = ?").run(kontoId, id);
  return id;
}

test('listAbholbereitJobs returns an unclaimed abgeschlossen job and marks it claimed', () => {
  const db = openDatabase(':memory:');
  const id = seedAbgeschlossenJob(db);
  const jobs = listAbholbereitJobs(db);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].id, id);
  assert.ok(jobs[0].fetched_by_n8n_at);
  const stored = getJobById(db, id);
  assert.ok(stored.fetched_by_n8n_at);
  db.close();
});

test('listAbholbereitJobs does not re-offer a job claimed within the stale window', () => {
  const db = openDatabase(':memory:');
  seedAbgeschlossenJob(db);
  listAbholbereitJobs(db);
  const secondCall = listAbholbereitJobs(db);
  assert.equal(secondCall.length, 0);
  db.close();
});

test('listAbholbereitJobs re-offers a job whose claim is older than staleAfterMs', () => {
  const db = openDatabase(':memory:');
  const id = seedAbgeschlossenJob(db);
  const oldTimestamp = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  db.prepare('UPDATE jobs SET fetched_by_n8n_at = ? WHERE id = ?').run(oldTimestamp, id);
  const jobs = listAbholbereitJobs(db, 15 * 60 * 1000);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].id, id);
  db.close();
});

test('listAbholbereitJobs ignores jobs that are not abgeschlossen', () => {
  const db = openDatabase(':memory:');
  seedKonto(db);
  createJob(db, { eingangAm: '2026-08-14T10:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  assert.equal(listAbholbereitJobs(db).length, 0);
  db.close();
});

test('confirmAbholung marks an abgeschlossen job abgeholt and returns it', () => {
  const db = openDatabase(':memory:');
  const id = seedAbgeschlossenJob(db);
  const job = confirmAbholung(db, id);
  assert.equal(job.status, 'abgeholt');
  assert.equal(getJobById(db, id).status, 'abgeholt');
  db.close();
});

test('confirmAbholung returns null for a job that is not abgeschlossen', () => {
  const db = openDatabase(':memory:');
  seedKonto(db);
  const id = createJob(db, { eingangAm: '2026-08-14T10:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  assert.equal(confirmAbholung(db, id), null);
  db.close();
});

test('confirmAbholung returns null on a second confirmation attempt', () => {
  const db = openDatabase(':memory:');
  const id = seedAbgeschlossenJob(db);
  confirmAbholung(db, id);
  assert.equal(confirmAbholung(db, id), null);
  db.close();
});

test('setThumbnailPfad sets thumbnail_pfad on the job row', () => {
  const db = openDatabase(':memory:');
  const jobsDir = '/tmp/does-not-need-to-exist';
  const id = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: `${jobsDir}/a.pdf` });
  assert.equal(getJobById(db, id).thumbnail_pfad, null);
  setThumbnailPfad(db, id, `${jobsDir}/a.png`);
  assert.equal(getJobById(db, id).thumbnail_pfad, `${jobsDir}/a.png`);
  db.close();
});

test('setKontierung sets konto_id on the job', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  setKontierung(db, jobId, kontoId);
  assert.equal(getJobById(db, jobId).konto_id, kontoId);
  db.close();
});

test('eskalierenFreigabe1 reassigns zugewiesen_an and records the escalation', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  eskalierenFreigabe1(db, jobId, { eskaliertVon: '1', grund: 'Befangen', stellvertreterId: '2' });
  const job = getJobById(db, jobId);
  assert.equal(job.zugewiesen_an, '2');
  assert.equal(job.freigabe1_eskaliert_von, '1');
  assert.equal(job.freigabe1_eskalationsgrund, 'Befangen');
  db.close();
});

test('abschliessenFreigabe1 sets status to freigabe2 and clears the escalation columns', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  eskalierenFreigabe1(db, jobId, { eskaliertVon: '1', grund: 'Befangen', stellvertreterId: '2' });
  abschliessenFreigabe1(db, jobId);
  const job = getJobById(db, jobId);
  assert.equal(job.status, 'freigabe2');
  assert.equal(job.freigabe1_eskaliert_von, null);
  assert.equal(job.freigabe1_eskalationsgrund, null);
  db.close();
});

test('abschliessenFreigabe1 preserves freigabe1_eskaliert_an_admin when set, so a later rework cycle stays locked to Portal-Admin (conflict-of-interest persists across attempts)', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  eskalierenFreigabe1AnAdmin(db, jobId, { eskaliertVon: '2', grund: 'Auch befangen' });
  assert.equal(getJobById(db, jobId).freigabe1_eskaliert_an_admin, 1);
  abschliessenFreigabe1(db, jobId);
  const job = getJobById(db, jobId);
  assert.equal(job.status, 'freigabe2');
  assert.equal(job.freigabe1_eskaliert_an_admin, 1, 'the conflict-of-interest flag survives Freigabe 1 completion, so rework cycles stay admin-gated');
  db.close();
});

test('eskalierenFreigabe2 records the escalation without changing status', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare("UPDATE jobs SET status = 'freigabe2' WHERE id = ?").run(jobId);
  eskalierenFreigabe2(db, jobId, { eskaliertVon: '3', grund: 'Befangen' });
  const job = getJobById(db, jobId);
  assert.equal(job.status, 'freigabe2');
  assert.equal(job.freigabe2_eskaliert_von, '3');
  assert.equal(job.freigabe2_eskalationsgrund, 'Befangen');
  db.close();
});

test('abschliessenFreigabe2 sets status to abgeschlossen and clears the escalation columns', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare("UPDATE jobs SET status = 'freigabe2' WHERE id = ?").run(jobId);
  eskalierenFreigabe2(db, jobId, { eskaliertVon: '3', grund: 'Befangen' });
  const completed = abschliessenFreigabe2(db, jobId);
  assert.equal(completed, true);
  const job = getJobById(db, jobId);
  assert.equal(job.status, 'abgeschlossen');
  assert.equal(job.freigabe2_eskaliert_von, null);
  assert.equal(job.freigabe2_eskalationsgrund, null);
  db.close();
});

test('abschliessenFreigabe2 clears freigabe2_eskaliert_an_admin, so a later rework cycle is not permanently locked to Portal-Admin', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare("UPDATE jobs SET status = 'freigabe2' WHERE id = ?").run(jobId);
  eskalierenFreigabe2AnAdmin(db, jobId, { eskaliertVon: '4', grund: 'Auch befangen' });
  assert.equal(getJobById(db, jobId).freigabe2_eskaliert_an_admin, 1);
  abschliessenFreigabe2(db, jobId);
  const job = getJobById(db, jobId);
  assert.equal(job.status, 'abgeschlossen');
  assert.equal(job.freigabe2_eskaliert_an_admin, 0);
  db.close();
});

test('abschliessenFreigabe2 atomically guards against completing a job twice', () => {
  const db = openDatabase(':memory:');
  seedKonto(db);
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare("UPDATE jobs SET status = 'freigabe2' WHERE id = ?").run(jobId);
  const firstCompletion = abschliessenFreigabe2(db, jobId);
  const secondCompletion = abschliessenFreigabe2(db, jobId);
  assert.equal(firstCompletion, true);
  assert.equal(secondCompletion, false);
  const job = getJobById(db, jobId);
  assert.equal(job.status, 'abgeschlossen');
  db.close();
});

test('releaseJob puts a zugewiesen job claimed by this person back into the pool', () => {
  const db = openDatabase(':memory:');
  seedKonto(db);
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, jobId, '1');
  const released = releaseJob(db, jobId, '1');
  assert.equal(released, true);
  const job = getJobById(db, jobId);
  assert.equal(job.status, 'unzugewiesen');
  assert.equal(job.zugewiesen_an, null);
  assert.equal(job.konto_id, null);
  db.close();
});

test('releaseJob refuses to release a job claimed by someone else', () => {
  const db = openDatabase(':memory:');
  seedKonto(db);
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, jobId, '1');
  const released = releaseJob(db, jobId, '2');
  assert.equal(released, false);
  assert.equal(getJobById(db, jobId).status, 'zugewiesen');
  db.close();
});

test('releaseJob clears a leftover freigabe1 escalation so a fresh claim starts clean', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, jobId, '1');
  eskalierenFreigabe1(db, jobId, { eskaliertVon: '1', grund: 'Befangen', stellvertreterId: '2' });
  // person '2' (the stellvertreter this escalated to) decides they don't recognize it either
  const released = releaseJob(db, jobId, '2');
  assert.equal(released, true);
  const job = getJobById(db, jobId);
  assert.equal(job.status, 'unzugewiesen');
  assert.equal(job.freigabe1_eskaliert_von, null);
  assert.equal(job.freigabe1_eskalationsgrund, null);
  db.close();
});

test('releaseJob clears freigabe1_eskaliert_an_admin, so a fresh claim by a non-admin is not permanently locked out', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, jobId, '1');
  eskalierenFreigabe1AnAdmin(db, jobId, { eskaliertVon: '2', grund: 'Auch befangen' });
  assert.equal(getJobById(db, jobId).freigabe1_eskaliert_an_admin, 1);
  // an admin, authorized via the flag branch, sends it back to the pool before Freigabe 1 was
  // ever completed -- this path never goes through abschliessenFreigabe1, so the flag must be
  // cleared here too, or the next (non-admin) claimer would be locked out of their own claim.
  const released = releaseJob(db, jobId, '1');
  assert.equal(released, true);
  const job = getJobById(db, jobId);
  assert.equal(job.status, 'unzugewiesen');
  assert.equal(job.freigabe1_eskaliert_an_admin, 0);
  db.close();
});

test('releaseJob clears stale freigabe2 escalation flags carried over from a prior cycle', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  // Simulate a job that reached freigabe2, got escalated to admin, was rejected, and reopened
  // (wiederOeffnenJob deliberately preserves freigabe2_eskaliert_* across that cycle) — it now
  // sits at status='zugewiesen' still carrying the stale Freigabe-2-stage flags.
  db.prepare(
    `UPDATE jobs SET status = 'zugewiesen', zugewiesen_an = '1', konto_id = ?,
       freigabe2_eskaliert_von = '3', freigabe2_eskalationsgrund = 'Befangen', freigabe2_eskaliert_an_admin = 1
     WHERE id = ?`
  ).run(kontoId, jobId);

  const released = releaseJob(db, jobId, '1');
  assert.equal(released, true);
  const job = getJobById(db, jobId);
  assert.equal(job.status, 'unzugewiesen');
  assert.equal(job.freigabe2_eskaliert_von, null);
  assert.equal(job.freigabe2_eskalationsgrund, null);
  assert.equal(job.freigabe2_eskaliert_an_admin, 0);
  db.close();
});

test('listZugewiesenJobsForPerson returns only zugewiesen jobs assigned to that person', () => {
  const db = openDatabase(':memory:');
  seedKonto(db);
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  const otherJobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'b.pdf', pdfPfad: '/tmp/b.pdf' });
  claimJob(db, jobId, '1');
  claimJob(db, otherJobId, '2');
  const rows = listZugewiesenJobsForPerson(db, '1');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, jobId);
  db.close();
});

test('listZugewiesenJobsForPerson excludes a job that has been admin-escalated past this person', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare("UPDATE jobs SET status = 'zugewiesen', zugewiesen_an = '2', konto_id = ? WHERE id = ?").run(kontoId, jobId);
  eskalierenFreigabe1AnAdmin(db, jobId, { eskaliertVon: '2', grund: 'Auch befangen' });

  // zugewiesen_an still technically equals '2' (the excluded former actor), but the job is no
  // longer theirs to act on once it's been escalated to Portal-Admin — it must not show up in
  // their own /pool listing as a link that now 403s.
  assert.equal(listZugewiesenJobsForPerson(db, '2').length, 0);
  db.close();
});

test('listFreigabe2JobsForPerson matches freigeber2_id when not escalated, stellvertreter2_id after escalation', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db); // freigeber2Id: '3', stellvertreter2Id: '4'
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  setKontierung(db, jobId, kontoId);
  db.prepare("UPDATE jobs SET status = 'freigabe2' WHERE id = ?").run(jobId);

  assert.equal(listFreigabe2JobsForPerson(db, '3').length, 1);
  assert.equal(listFreigabe2JobsForPerson(db, '4').length, 0);

  eskalierenFreigabe2(db, jobId, { eskaliertVon: '3', grund: 'Befangen' });
  assert.equal(listFreigabe2JobsForPerson(db, '3').length, 0);
  assert.equal(listFreigabe2JobsForPerson(db, '4').length, 1);
  db.close();
});

test('listFreigabe2JobsForPerson excludes a job that has been admin-escalated past the excluded stellvertreter2', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db); // freigeber2Id: '3', stellvertreter2Id: '4'
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  setKontierung(db, jobId, kontoId);
  db.prepare("UPDATE jobs SET status = 'freigabe2' WHERE id = ?").run(jobId);
  eskalierenFreigabe2(db, jobId, { eskaliertVon: '3', grund: 'Befangen' });
  eskalierenFreigabe2AnAdmin(db, jobId, { eskaliertVon: '4', grund: 'Auch befangen' });

  // Once escalated to admin, neither the original freigeber2 nor the excluded stellvertreter2
  // should still see this job in their own /pool listing.
  assert.equal(listFreigabe2JobsForPerson(db, '3').length, 0);
  assert.equal(listFreigabe2JobsForPerson(db, '4').length, 0);
  db.close();
});

test('getEffectiveFreigeber2Id returns freigeber2_id normally, stellvertreter2_id after escalation', () => {
  const konto = { freigeber2_id: '3', stellvertreter2_id: '4' };
  assert.equal(getEffectiveFreigeber2Id({ freigabe2_eskaliert_von: null }, konto), '3');
  assert.equal(getEffectiveFreigeber2Id({ freigabe2_eskaliert_von: '3' }, konto), '4');
});

test('ablehnenJob sets status to abgelehnt with the rejection reason when the job is in freigabe2', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, jobId, '1');
  setKontierung(db, jobId, kontoId);
  db.prepare("UPDATE jobs SET status = 'freigabe2' WHERE id = ?").run(jobId);

  const result = ablehnenJob(db, jobId, { abgelehntVon: '3', grund: 'Falsches Konto' });
  assert.equal(result, true);
  const job = getJobById(db, jobId);
  assert.equal(job.status, 'abgelehnt');
  assert.equal(job.abgelehnt_von, '3');
  assert.equal(job.ablehnungsgrund, 'Falsches Konto');
  db.close();
});

test('ablehnenJob refuses to reject a job that is not in freigabe2', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, jobId, '1');
  const result = ablehnenJob(db, jobId, { abgelehntVon: '3', grund: 'zu spät' });
  assert.equal(result, false);
  assert.equal(getJobById(db, jobId).status, 'zugewiesen');
  db.close();
});

test('wiederOeffnenJob resets an abgelehnt job to zugewiesen and clears the rejection fields', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, jobId, '1');
  setKontierung(db, jobId, kontoId);
  db.prepare("UPDATE jobs SET status = 'freigabe2' WHERE id = ?").run(jobId);
  ablehnenJob(db, jobId, { abgelehntVon: '3', grund: 'Falsches Konto' });

  const result = wiederOeffnenJob(db, jobId, '1');
  assert.equal(result, true);
  const job = getJobById(db, jobId);
  assert.equal(job.status, 'zugewiesen');
  assert.equal(job.abgelehnt_von, null);
  assert.equal(job.ablehnungsgrund, null);
  assert.equal(job.konto_id, kontoId, 'konto_id must survive a reopen so the Kontierung form stays pre-filled');
  db.close();
});

test('wiederOeffnenJob refuses to reopen a job for someone other than zugewiesen_an', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, jobId, '1');
  setKontierung(db, jobId, kontoId);
  db.prepare("UPDATE jobs SET status = 'freigabe2' WHERE id = ?").run(jobId);
  ablehnenJob(db, jobId, { abgelehntVon: '3', grund: 'Falsches Konto' });

  const result = wiederOeffnenJob(db, jobId, '2');
  assert.equal(result, false);
  assert.equal(getJobById(db, jobId).status, 'abgelehnt');
  db.close();
});

test('wiederOeffnenJob deliberately leaves a Freigabe-2 escalation in place across a reject/rework cycle', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db); // freigeber2Id: '3', stellvertreter2Id: '4'
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, jobId, '1');
  setKontierung(db, jobId, kontoId);
  db.prepare("UPDATE jobs SET status = 'freigabe2' WHERE id = ?").run(jobId);
  eskalierenFreigabe2(db, jobId, { eskaliertVon: '3', grund: 'Befangen' });

  ablehnenJob(db, jobId, { abgelehntVon: '4', grund: 'Falsches Konto' });
  wiederOeffnenJob(db, jobId, '1');

  const job = getJobById(db, jobId);
  assert.equal(job.status, 'zugewiesen');
  assert.equal(job.freigabe2_eskaliert_von, '3', 'the Freigabe-2 escalation must survive rework — the conflict is still real');
  assert.equal(job.freigabe2_eskalationsgrund, 'Befangen');
  db.close();
});

test('wiederOeffnenJob refuses to reopen a job that is not abgelehnt', () => {
  const db = openDatabase(':memory:');
  seedKonto(db);
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, jobId, '1');
  const result = wiederOeffnenJob(db, jobId, '1');
  assert.equal(result, false);
  db.close();
});

test('listAbgelehntJobsForPerson returns only abgelehnt jobs assigned to that person', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, jobId, '1');
  setKontierung(db, jobId, kontoId);
  db.prepare("UPDATE jobs SET status = 'freigabe2' WHERE id = ?").run(jobId);
  ablehnenJob(db, jobId, { abgelehntVon: '3', grund: 'Falsches Konto' });

  const otherJobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'b.pdf', pdfPfad: '/tmp/b.pdf' });
  claimJob(db, otherJobId, '1');

  const rows = listAbgelehntJobsForPerson(db, '1');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, jobId);
  assert.equal(listAbgelehntJobsForPerson(db, '2').length, 0);
  db.close();
});

test('abschliessenFreigabe1 leaves freigabe1_eskaliert_an_admin set when it was already 1 (the exclusion survives Freigabe 1 completing)', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare("UPDATE jobs SET status = 'zugewiesen', zugewiesen_an = '2', konto_id = ? WHERE id = ?").run(kontoId, jobId);
  eskalierenFreigabe1AnAdmin(db, jobId, { eskaliertVon: '2', grund: 'Auch befangen' });

  abschliessenFreigabe1(db, jobId);

  const job = getJobById(db, jobId);
  assert.equal(job.status, 'freigabe2');
  assert.equal(job.freigabe1_eskaliert_von, null, 'the named-person escalation record is still cleared — only the admin-exclusion flag must survive');
  assert.equal(job.freigabe1_eskaliert_an_admin, 1, 'the conflict-of-interest exclusion must survive Freigabe 1 completing, so a later reject+rework cycle stays admin-gated');
  db.close();
});

test('abschliessenFreigabe1 leaves freigabe1_eskaliert_an_admin at 0 for a normal (non-escalated) completion', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare("UPDATE jobs SET status = 'zugewiesen', zugewiesen_an = '1', konto_id = ? WHERE id = ?").run(kontoId, jobId);

  abschliessenFreigabe1(db, jobId);

  const job = getJobById(db, jobId);
  assert.equal(job.freigabe1_eskaliert_an_admin, 0);
  db.close();
});

test('listPoolJobsForReminder returns only unzugewiesen jobs older than the threshold with no reminder sent yet', () => {
  const db = openDatabase(':memory:');
  const oldJobId = createJob(db, { eingangAm: '2020-01-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'alt.pdf', pdfPfad: '/tmp/a.pdf' });
  const freshJobId = createJob(db, { eingangAm: new Date().toISOString(), quelle: 'scanner', absender: null, dateiname: 'neu.pdf', pdfPfad: '/tmp/b.pdf' });

  const results = listPoolJobsForReminder(db, 24);
  const ids = results.map((r) => r.id);
  assert.ok(ids.includes(oldJobId));
  assert.ok(!ids.includes(freshJobId));
  db.close();
});

test('listPoolJobsForReminder excludes a job whose reminder was already sent', () => {
  const db = openDatabase(':memory:');
  const jobId = createJob(db, { eingangAm: '2020-01-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'alt.pdf', pdfPfad: '/tmp/a.pdf' });
  markReminderGesendet(db, jobId);
  assert.equal(listPoolJobsForReminder(db, 24).length, 0);
  db.close();
});

test('listPoolJobsForReminder excludes a claimed (non-pool) job even if old', () => {
  const db = openDatabase(':memory:');
  seedKonto(db);
  const jobId = createJob(db, { eingangAm: '2020-01-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'alt.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, jobId, '1');
  assert.equal(listPoolJobsForReminder(db, 24).length, 0);
  db.close();
});

test('listPoolJobsForEskalation returns only unzugewiesen jobs older than the threshold with no escalation sent yet', () => {
  const db = openDatabase(':memory:');
  const oldJobId = createJob(db, { eingangAm: '2020-01-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'alt.pdf', pdfPfad: '/tmp/a.pdf' });
  const results = listPoolJobsForEskalation(db, 48);
  assert.equal(results.length, 1);
  assert.equal(results[0].id, oldJobId);
  db.close();
});

test('markReminderGesendet and markEskalationGesendet each gate only their own list', () => {
  const db = openDatabase(':memory:');
  const jobId = createJob(db, { eingangAm: '2020-01-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'alt.pdf', pdfPfad: '/tmp/a.pdf' });
  markReminderGesendet(db, jobId);
  assert.equal(listPoolJobsForReminder(db, 24).length, 0, 'reminder list excludes it once marked');
  assert.equal(listPoolJobsForEskalation(db, 48).length, 1, 'escalation list is independent, still includes it');
  db.close();
});

test('releaseJob clears reminder_gesendet_at and eskalation_gesendet_at so a fresh pool cycle starts clean', () => {
  const db = openDatabase(':memory:');
  seedKonto(db);
  const jobId = createJob(db, { eingangAm: '2020-01-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  markReminderGesendet(db, jobId);
  markEskalationGesendet(db, jobId);
  claimJob(db, jobId, '1');

  releaseJob(db, jobId, '1');
  const job = getJobById(db, jobId);
  assert.equal(job.reminder_gesendet_at, null);
  assert.equal(job.eskalation_gesendet_at, null);
  db.close();
});

test('listAbgeholtJobs returns only abgeholt jobs', () => {
  const db = openDatabase(':memory:');
  const abgeholtId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare("UPDATE jobs SET status = 'abgeholt' WHERE id = ?").run(abgeholtId);
  createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'b.pdf', pdfPfad: '/tmp/b.pdf' });

  const rows = listAbgeholtJobs(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, abgeholtId);
  db.close();
});

test('archivierenJob transitions an abgeholt job to archiviert and sets archiviert_am', () => {
  const db = openDatabase(':memory:');
  const jobId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare("UPDATE jobs SET status = 'abgeholt' WHERE id = ?").run(jobId);

  const result = archivierenJob(db, jobId);
  assert.equal(result, true);
  const job = getJobById(db, jobId);
  assert.equal(job.status, 'archiviert');
  assert.ok(job.archiviert_am);
  db.close();
});

test('archivierenJob refuses to archive a job that is not abgeholt', () => {
  const db = openDatabase(':memory:');
  const jobId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });

  const result = archivierenJob(db, jobId);
  assert.equal(result, false);
  assert.equal(getJobById(db, jobId).status, 'unzugewiesen');
  db.close();
});

test('eskalierenFreigabe1AnAdmin sets the admin-escalation flag and records who/why, leaving zugewiesen_an untouched', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const jobId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare("UPDATE jobs SET status = 'zugewiesen', zugewiesen_an = '2', konto_id = ? WHERE id = ?").run(kontoId, jobId);

  eskalierenFreigabe1AnAdmin(db, jobId, { eskaliertVon: '2', grund: 'Auch ein Interessenskonflikt' });

  const job = getJobById(db, jobId);
  assert.equal(job.freigabe1_eskaliert_an_admin, 1);
  assert.equal(job.freigabe1_eskaliert_von, '2');
  assert.equal(job.freigabe1_eskalationsgrund, 'Auch ein Interessenskonflikt');
  assert.equal(job.zugewiesen_an, '2');
  db.close();
});

test('eskalierenFreigabe2AnAdmin sets the admin-escalation flag and records who/why', () => {
  const db = openDatabase(':memory:');
  seedKonto(db);
  const jobId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare("UPDATE jobs SET status = 'freigabe2' WHERE id = ?").run(jobId);

  eskalierenFreigabe2AnAdmin(db, jobId, { eskaliertVon: '4', grund: 'Auch ein Interessenskonflikt' });

  const job = getJobById(db, jobId);
  assert.equal(job.freigabe2_eskaliert_an_admin, 1);
  assert.equal(job.freigabe2_eskaliert_von, '4');
  assert.equal(job.freigabe2_eskalationsgrund, 'Auch ein Interessenskonflikt');
  db.close();
});

test('listStalledJobs finds a zugewiesen job whose actor was deactivated', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const jobId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare("UPDATE jobs SET status = 'zugewiesen', zugewiesen_an = '1', konto_id = ? WHERE id = ?").run(kontoId, jobId);
  db.prepare("UPDATE personen SET aktiv = 0 WHERE churchtools_person_id = '1'").run();

  const stalled = listStalledJobs(db);
  assert.equal(stalled.length, 1);
  assert.equal(stalled[0].job.id, jobId);
  assert.equal(stalled[0].akteurId, '1');
  assert.equal(stalled[0].grund, 'inaktiv');
  db.close();
});

test('listStalledJobs finds an abgelehnt job whose actor is not auflösbar', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const jobId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare("UPDATE jobs SET status = 'abgelehnt', zugewiesen_an = '1', konto_id = ? WHERE id = ?").run(kontoId, jobId);
  db.prepare("UPDATE personen SET ct_person_unresolved = 1 WHERE churchtools_person_id = '1'").run();

  const stalled = listStalledJobs(db);
  assert.equal(stalled.length, 1);
  assert.equal(stalled[0].grund, 'nicht_aufloesbar');
  db.close();
});

test('listStalledJobs finds a freigabe2 job whose effective freigeber2 is inactive', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const jobId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare("UPDATE jobs SET status = 'freigabe2', konto_id = ? WHERE id = ?").run(kontoId, jobId);
  db.prepare("UPDATE personen SET aktiv = 0 WHERE churchtools_person_id = '3'").run();

  const stalled = listStalledJobs(db);
  assert.equal(stalled.length, 1);
  assert.equal(stalled[0].akteurId, '3');
  db.close();
});

test('listStalledJobs excludes a freigabe2 job already escalated to admin', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const jobId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare("UPDATE jobs SET status = 'freigabe2', konto_id = ?, freigabe2_eskaliert_an_admin = 1 WHERE id = ?").run(kontoId, jobId);
  db.prepare("UPDATE personen SET aktiv = 0 WHERE churchtools_person_id = '3'").run();
  db.prepare("UPDATE personen SET aktiv = 0 WHERE churchtools_person_id = '4'").run();

  assert.equal(listStalledJobs(db).length, 0);
  db.close();
});

test('listStalledJobs excludes a healthy job with an active, resolvable actor', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const jobId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare("UPDATE jobs SET status = 'zugewiesen', zugewiesen_an = '1', konto_id = ? WHERE id = ?").run(kontoId, jobId);

  assert.equal(listStalledJobs(db).length, 0);
  db.close();
});

test('forceReleaseJob resets a stalled zugewiesen job to unzugewiesen', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const jobId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare("UPDATE jobs SET status = 'zugewiesen', zugewiesen_an = '1', konto_id = ? WHERE id = ?").run(kontoId, jobId);

  const result = forceReleaseJob(db, jobId);
  assert.equal(result, true);
  const job = getJobById(db, jobId);
  assert.equal(job.status, 'unzugewiesen');
  assert.equal(job.zugewiesen_an, null);
  assert.equal(job.konto_id, null);
  db.close();
});

test('forceReleaseJob resets a stalled abgelehnt job to unzugewiesen', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const jobId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare("UPDATE jobs SET status = 'abgelehnt', zugewiesen_an = '1', konto_id = ?, abgelehnt_von = '3', ablehnungsgrund = 'x' WHERE id = ?").run(kontoId, jobId);

  const result = forceReleaseJob(db, jobId);
  assert.equal(result, true);
  const job = getJobById(db, jobId);
  assert.equal(job.status, 'unzugewiesen');
  assert.equal(job.abgelehnt_von, null);
  db.close();
});

test('forceReleaseJob clears stale freigabe2 escalation flags carried over from a prior cycle', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const jobId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  // Simulate a job that reached freigabe2, got escalated to admin, was rejected, and reopened
  // (wiederOeffnenJob deliberately preserves freigabe2_eskaliert_* across that cycle) — it now
  // sits at status='zugewiesen' still carrying the stale Freigabe-2-stage flags.
  db.prepare(
    `UPDATE jobs SET status = 'zugewiesen', zugewiesen_an = '1', konto_id = ?,
       freigabe2_eskaliert_von = '3', freigabe2_eskalationsgrund = 'Befangen', freigabe2_eskaliert_an_admin = 1
     WHERE id = ?`
  ).run(kontoId, jobId);

  const result = forceReleaseJob(db, jobId);
  assert.equal(result, true);
  const job = getJobById(db, jobId);
  assert.equal(job.status, 'unzugewiesen');
  assert.equal(job.freigabe2_eskaliert_von, null);
  assert.equal(job.freigabe2_eskalationsgrund, null);
  assert.equal(job.freigabe2_eskaliert_an_admin, 0);
  db.close();
});

test('forceReleaseJob refuses a job that is not in a force-releasable status', () => {
  const db = openDatabase(':memory:');
  const jobId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  assert.equal(forceReleaseJob(db, jobId), false);
  db.close();
});

test('forceEskalierenFreigabe2AnAdmin sets the admin flag on a stalled freigabe2 job', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const jobId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare("UPDATE jobs SET status = 'freigabe2', konto_id = ? WHERE id = ?").run(kontoId, jobId);

  const result = forceEskalierenFreigabe2AnAdmin(db, jobId);
  assert.equal(result, true);
  assert.equal(getJobById(db, jobId).freigabe2_eskaliert_an_admin, 1);
  db.close();
});

test('forceEskalierenFreigabe2AnAdmin refuses a job not in freigabe2 or already escalated', () => {
  const db = openDatabase(':memory:');
  const jobId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  assert.equal(forceEskalierenFreigabe2AnAdmin(db, jobId), false);
  db.close();
});
