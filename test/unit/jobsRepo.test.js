import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createKonto, deactivateKonto } from '../../src/db/kontenRepo.js';
import { createZuweisungsregel } from '../../src/db/zuweisungsregelnRepo.js';
import { findMatchingZuweisungsregel, createJob, getJobById, listPoolJobs, claimJob, listAbholbereitJobs, confirmAbholung, setThumbnailPfad, setKontierung, eskalierenFreigabe1, abschliessenFreigabe1, eskalierenFreigabe2, abschliessenFreigabe2, releaseJob, listZugewiesenJobsForPerson, listFreigabe2JobsForPerson, getEffectiveFreigeber2Id, ablehnenJob, wiederOeffnenJob, listAbgelehntJobsForPerson } from '../../src/db/jobsRepo.js';

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

test('getEffectiveFreigeber2Id returns freigeber2_id normally, stellvertreter2_id after escalation', () => {
  const konto = { freigeber2_id: '3', stellvertreter2_id: '4' };
  assert.equal(getEffectiveFreigeber2Id({ freigabe2_eskaliert_von: null }, konto), '3');
  assert.equal(getEffectiveFreigeber2Id({ freigabe2_eskaliert_von: '3' }, konto), '4');
});

test('ablehnenJob sets status to abgelehnt with the rejection reason when the job is in freigabe2', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
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
  setKontierung(db, jobId, kontoId);
  db.prepare("UPDATE jobs SET status = 'freigabe2' WHERE id = ?").run(jobId);
  ablehnenJob(db, jobId, { abgelehntVon: '3', grund: 'Falsches Konto' });

  const result = wiederOeffnenJob(db, jobId, '2');
  assert.equal(result, false);
  assert.equal(getJobById(db, jobId).status, 'abgelehnt');
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
