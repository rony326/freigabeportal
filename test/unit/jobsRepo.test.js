import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createKonto, deactivateKonto } from '../../src/db/kontenRepo.js';
import { createZuweisungsregel } from '../../src/db/zuweisungsregelnRepo.js';
import { findMatchingZuweisungsregel, createJob, getJobById, listPoolJobs, claimJob } from '../../src/db/jobsRepo.js';

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
