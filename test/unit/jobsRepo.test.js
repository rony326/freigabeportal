import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createKonto, deactivateKonto } from '../../src/db/kontenRepo.js';
import { createZuweisungsregel } from '../../src/db/zuweisungsregelnRepo.js';
import { createDebitor } from '../../src/db/debitorenRepo.js';
import { createFreigabe, listFreigabenByJob } from '../../src/db/freigabenRepo.js';
import { findMatchingZuweisungsregel, createJob, getJobById, findJobByDateiHash, listPoolJobs, claimJob, listAbholbereitJobs, confirmAbholung, setThumbnailPfad, setKontierung, updateKontierungMetadaten, eskalierenFreigabe1, abschliessenFreigabe1, eskalierenFreigabe2, abschliessenFreigabe2, releaseJob, listZugewiesenJobsForPerson, listFreigabe2JobsForPerson, getEffectiveFreigeber2Id, ablehnenJob, wiederOeffnenJob, listAbgelehntJobsForPerson, listAlleAbgelehntenJobs, loeschenJob, listPoolJobsForReminder, markReminderGesendet, listPoolJobsForEskalation, markEskalationGesendet, listAbgeholtJobs, archivierenJob, eskalierenFreigabe1AnAdmin, eskalierenFreigabe2AnAdmin, listStalledJobs, forceReleaseJob, forceEskalierenFreigabe2AnAdmin, markJobAufgesplittet, createSplitJob, listSplitKinder, listAdminEskalierteKontierungen, listAdminEskalierteFreigaben, markZeitstempelGesetzt, listAbgeschlossenJobsForPerson, countZeitstempelUeberfaellig, listZeitstempelAusstehendJobs, setQrDaten } from '../../src/db/jobsRepo.js';

function seedKonto(db) {
  for (const id of ['1', '2', '3', '4']) {
    upsertPerson(db, { id, vorname: `Person${id}`, nachname: 'Muster', email: `p${id}@example.org`, gruppen: ['10'], loggedInNow: false });
  }
  return createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
}

// Zuweisungsregeln match Absender -> Debitor; the Debitor optionally carries a default Konto
// that the auto-assignment then resolves through. Most tests here just need "a Debitor pointing
// at this Konto", so this wraps both steps.
function seedDebitorMitKonto(db, kontoId, name = 'Muster AG') {
  return createDebitor(db, { name, kontoId });
}

test('findMatchingZuweisungsregel: exact email address matches', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const debitorId = seedDebitorMitKonto(db, kontoId);
  createZuweisungsregel(db, { absenderMuster: 'rechnungen@lieferant.ch', debitorId });
  const regel = findMatchingZuweisungsregel(db, 'rechnungen@lieferant.ch');
  assert.equal(regel.debitor_id, debitorId);
  db.close();
});

test('findMatchingZuweisungsregel: domain pattern matches a subdomain sender', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const debitorId = seedDebitorMitKonto(db, kontoId);
  createZuweisungsregel(db, { absenderMuster: 'lieferant.ch', debitorId });
  const regel = findMatchingZuweisungsregel(db, 'rechnungen@sub.lieferant.ch');
  assert.equal(regel.debitor_id, debitorId);
  db.close();
});

test('findMatchingZuweisungsregel: domain pattern does not match an unrelated domain sharing a suffix', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const debitorId = seedDebitorMitKonto(db, kontoId);
  createZuweisungsregel(db, { absenderMuster: 'lieferant.ch', debitorId });
  assert.equal(findMatchingZuweisungsregel(db, 'rechnungen@notlieferant.ch'), null);
  db.close();
});

test('findMatchingZuweisungsregel: exact address wins over a domain rule that would also match', () => {
  const db = openDatabase(':memory:');
  const kontoId1 = seedKonto(db);
  upsertPerson(db, { id: '5', vorname: 'P5', nachname: 'Muster', email: 'p5@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '6', vorname: 'P6', nachname: 'Muster', email: 'p6@example.org', gruppen: ['10'], loggedInNow: false });
  const kontoId2 = createKonto(db, { kontonummer: '3001', bezeichnung: 'Spezial', freigeber1Id: '5', stellvertreter1Id: '6', freigeber2Id: '1', stellvertreter2Id: '2' });
  const debitorId1 = seedDebitorMitKonto(db, kontoId1, 'Debitor 1');
  const debitorId2 = seedDebitorMitKonto(db, kontoId2, 'Debitor 2');
  createZuweisungsregel(db, { absenderMuster: 'lieferant.ch', debitorId: debitorId1 });
  createZuweisungsregel(db, { absenderMuster: 'rechnungen@lieferant.ch', debitorId: debitorId2 });
  const regel = findMatchingZuweisungsregel(db, 'rechnungen@lieferant.ch');
  assert.equal(regel.debitor_id, debitorId2);
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
  const debitorId = seedDebitorMitKonto(db, kontoId);
  createZuweisungsregel(db, { absenderMuster: 'lieferant.ch', debitorId });
  const regel = findMatchingZuweisungsregel(db, '"Lieferant AG" <rechnung@lieferant.ch>');
  assert.equal(regel.debitor_id, debitorId);
  db.close();
});

test('findMatchingZuweisungsregel: a comma-separated multi-address sender with no brackets matches nothing (refuses to guess)', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const debitorId = seedDebitorMitKonto(db, kontoId);
  createZuweisungsregel(db, { absenderMuster: 'lieferant.ch', debitorId });
  // Naive lastIndexOf('@') parsing would have matched "lieferant.ch" here, letting an attacker
  // steer an invoice to a chosen Konto/approver by appending a trailing legitimate-looking
  // address after their own.
  assert.equal(findMatchingZuweisungsregel(db, 'billing@attacker.example, buchhaltung@lieferant.ch'), null);
  db.close();
});

test('findMatchingZuweisungsregel: a multi-address sender where the legitimate address is bracketed still matches nothing', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const debitorId = seedDebitorMitKonto(db, kontoId);
  createZuweisungsregel(db, { absenderMuster: 'lieferant.ch', debitorId });
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
  const debitorId = seedDebitorMitKonto(db, kontoId);
  createZuweisungsregel(db, { absenderMuster: 'lieferant.ch', debitorId });
  assert.equal(findMatchingZuweisungsregel(db, 'not-an-email-address'), null);
  db.close();
});

test('createJob auto-assigns via a matching Zuweisungsregel, and fills lieferant/debitor_id from the Debitor', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const debitorId = seedDebitorMitKonto(db, kontoId);
  createZuweisungsregel(db, { absenderMuster: 'lieferant.ch', debitorId });
  const id = createJob(db, { eingangAm: '2026-08-14T10:00:00.000Z', quelle: 'lieferant', absender: 'rechnungen@lieferant.ch', dateiname: 'rechnung.pdf', pdfPfad: '/tmp/x.pdf' });
  const job = getJobById(db, id);
  assert.equal(job.status, 'zugewiesen');
  assert.equal(job.konto_id, kontoId);
  assert.equal(job.zugewiesen_an, '1');
  assert.equal(job.debitor_id, debitorId);
  assert.equal(job.lieferant, 'Muster AG');
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

test('createJob stores an optional dateiHash, and findJobByDateiHash finds it back', () => {
  const db = openDatabase(':memory:');
  const id = createJob(db, { eingangAm: '2026-08-14T10:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'scan.pdf', pdfPfad: '/tmp/y.pdf', dateiHash: 'abc123' });
  const job = getJobById(db, id);
  assert.equal(job.datei_hash, 'abc123');
  const found = findJobByDateiHash(db, 'abc123');
  assert.equal(found.id, id);
  db.close();
});

test('findJobByDateiHash returns null when no job has that hash, and ignores jobs with a null hash', () => {
  const db = openDatabase(':memory:');
  createJob(db, { eingangAm: '2026-08-14T10:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'scan.pdf', pdfPfad: '/tmp/y.pdf' });
  assert.equal(findJobByDateiHash(db, 'does-not-exist'), null);
  db.close();
});

test('createJob falls back to the pool when the matched Konto is inactive, but still fills lieferant from the Debitor', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const debitorId = seedDebitorMitKonto(db, kontoId);
  createZuweisungsregel(db, { absenderMuster: 'lieferant.ch', debitorId });
  deactivateKonto(db, kontoId);
  const id = createJob(db, { eingangAm: '2026-08-14T10:00:00.000Z', quelle: 'lieferant', absender: 'rechnungen@lieferant.ch', dateiname: 'rechnung.pdf', pdfPfad: '/tmp/z.pdf' });
  const job = getJobById(db, id);
  assert.equal(job.status, 'unzugewiesen');
  assert.equal(job.konto_id, null);
  assert.equal(job.lieferant, 'Muster AG');
  db.close();
});

test('createJob leaves a job unzugewiesen when the matching Debitor has no default Konto, but still fills lieferant', () => {
  const db = openDatabase(':memory:');
  seedKonto(db);
  const debitorId = createDebitor(db, { name: 'Kein Konto AG', kontoId: null });
  createZuweisungsregel(db, { absenderMuster: 'lieferant.ch', debitorId });
  const id = createJob(db, { eingangAm: '2026-08-14T10:00:00.000Z', quelle: 'lieferant', absender: 'rechnungen@lieferant.ch', dateiname: 'rechnung.pdf', pdfPfad: '/tmp/z.pdf' });
  const job = getJobById(db, id);
  assert.equal(job.status, 'unzugewiesen');
  assert.equal(job.konto_id, null);
  assert.equal(job.debitor_id, debitorId);
  assert.equal(job.lieferant, 'Kein Konto AG');
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
  const debitorId = seedDebitorMitKonto(db, kontoId);
  createZuweisungsregel(db, { absenderMuster: 'lieferant.ch', debitorId });
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

test('listAbholbereitJobs, with nurMitZeitstempel true, omits an abgeschlossen job that has no timestamp yet', () => {
  const db = openDatabase(':memory:');
  seedAbgeschlossenJob(db);
  assert.equal(listAbholbereitJobs(db, undefined, true).length, 0);
  db.close();
});

test('listAbholbereitJobs, with nurMitZeitstempel true, includes an abgeschlossen job once zeitstempel_gesetzt_am is set', () => {
  const db = openDatabase(':memory:');
  const id = seedAbgeschlossenJob(db);
  db.prepare('UPDATE jobs SET zeitstempel_gesetzt_am = ? WHERE id = ?').run('2026-08-21T09:00:00.000Z', id);
  const jobs = listAbholbereitJobs(db, undefined, true);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].id, id);
  db.close();
});

test('listAbholbereitJobs, with nurMitZeitstempel false (default), includes a job without a timestamp', () => {
  const db = openDatabase(':memory:');
  seedAbgeschlossenJob(db);
  assert.equal(listAbholbereitJobs(db).length, 1);
  db.close();
});

test('confirmAbholung, with nurMitZeitstempel true, refuses a job that has no timestamp yet', () => {
  const db = openDatabase(':memory:');
  const id = seedAbgeschlossenJob(db);
  assert.equal(confirmAbholung(db, id, true), null);
  assert.equal(getJobById(db, id).status, 'abgeschlossen');
  db.close();
});

test('confirmAbholung, with nurMitZeitstempel true, succeeds once zeitstempel_gesetzt_am is set', () => {
  const db = openDatabase(':memory:');
  const id = seedAbgeschlossenJob(db);
  db.prepare('UPDATE jobs SET zeitstempel_gesetzt_am = ? WHERE id = ?').run('2026-08-21T09:00:00.000Z', id);
  const job = confirmAbholung(db, id, true);
  assert.equal(job.status, 'abgeholt');
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

test('updateKontierungMetadaten persists absender, betrag, zahlungsziel, rechnungsnummer and lieferant', () => {
  const db = openDatabase(':memory:');
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  updateKontierungMetadaten(db, jobId, {
    absender: 'lieferant@example.org',
    betrag: '123.45',
    zahlungsziel: '2026-09-01',
    rechnungsnummer: 'RE-2026-042',
    lieferant: 'Muster AG',
  });
  const job = getJobById(db, jobId);
  assert.equal(job.absender, 'lieferant@example.org');
  assert.equal(job.betrag, '123.45');
  assert.equal(job.zahlungsziel, '2026-09-01');
  assert.equal(job.rechnungsnummer, 'RE-2026-042');
  assert.equal(job.lieferant, 'Muster AG');
  db.close();
});

test('updateKontierungMetadaten stores null for empty values instead of empty strings', () => {
  const db = openDatabase(':memory:');
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: 'alt@example.org', dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  updateKontierungMetadaten(db, jobId, { absender: '', betrag: '', zahlungsziel: '', rechnungsnummer: '', lieferant: '' });
  const job = getJobById(db, jobId);
  assert.equal(job.absender, null);
  assert.equal(job.betrag, null);
  assert.equal(job.zahlungsziel, null);
  assert.equal(job.rechnungsnummer, null);
  assert.equal(job.lieferant, null);
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

test('abschliessenFreigabe2 sets abgeschlossen_am', () => {
  const db = openDatabase(':memory:');
  seedKonto(db);
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare("UPDATE jobs SET status = 'freigabe2' WHERE id = ?").run(jobId);
  assert.equal(getJobById(db, jobId).abgeschlossen_am, null);
  abschliessenFreigabe2(db, jobId);
  assert.ok(getJobById(db, jobId).abgeschlossen_am);
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

test('listZeitstempelAusstehendJobs returns an abgeschlossen job that has no timestamp yet', () => {
  const db = openDatabase(':memory:');
  const id = seedAbgeschlossenJob(db);
  const jobs = listZeitstempelAusstehendJobs(db);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].id, id);
  assert.equal(jobs[0].pdf_pfad, '/tmp/a.pdf', 'full job rows are returned — the nachhol-job needs pdf_pfad');
  db.close();
});

test('listZeitstempelAusstehendJobs ignores a job that already has a timestamp', () => {
  const db = openDatabase(':memory:');
  const id = seedAbgeschlossenJob(db);
  markZeitstempelGesetzt(db, id, '2026-08-20T10:00:00.000Z');
  assert.equal(listZeitstempelAusstehendJobs(db).length, 0);
  db.close();
});

test('listZeitstempelAusstehendJobs ignores jobs that have not reached abgeschlossen, and ones that already moved past it', () => {
  const db = openDatabase(':memory:');
  const id = seedAbgeschlossenJob(db);
  for (const status of ['freigabe2', 'abgeholt', 'archiviert', 'abgelehnt']) {
    db.prepare('UPDATE jobs SET status = ? WHERE id = ?').run(status, id);
    assert.equal(listZeitstempelAusstehendJobs(db).length, 0, `status ${status} must not be in the nachhol work list`);
  }
  db.close();
});

test('countZeitstempelUeberfaellig counts an abgeschlossen job past the threshold with no timestamp', () => {
  const db = openDatabase(':memory:');
  const id = seedAbgeschlossenJob(db);
  const alt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
  db.prepare('UPDATE jobs SET abgeschlossen_am = ? WHERE id = ?').run(alt, id);
  assert.equal(countZeitstempelUeberfaellig(db, 2), 1);
  db.close();
});

test('countZeitstempelUeberfaellig ignores a job that already has a timestamp', () => {
  const db = openDatabase(':memory:');
  const id = seedAbgeschlossenJob(db);
  const alt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
  db.prepare('UPDATE jobs SET abgeschlossen_am = ?, zeitstempel_gesetzt_am = ? WHERE id = ?').run(alt, alt, id);
  assert.equal(countZeitstempelUeberfaellig(db, 2), 0);
  db.close();
});

test('countZeitstempelUeberfaellig ignores a job that has not yet crossed the threshold', () => {
  const db = openDatabase(':memory:');
  const id = seedAbgeschlossenJob(db);
  const neu = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  db.prepare('UPDATE jobs SET abgeschlossen_am = ? WHERE id = ?').run(neu, id);
  assert.equal(countZeitstempelUeberfaellig(db, 2), 0);
  db.close();
});

test('countZeitstempelUeberfaellig ignores a pre-feature abgeschlossen job with no abgeschlossen_am recorded', () => {
  const db = openDatabase(':memory:');
  seedAbgeschlossenJob(db);
  assert.equal(countZeitstempelUeberfaellig(db, 2), 0);
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

test('listAbgeschlossenJobsForPerson matches a job by freigeber2_id and lists it across all three completed statuses', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db); // freigeber2Id: '3', stellvertreter2Id: '4'
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  setKontierung(db, jobId, kontoId);

  for (const status of ['abgeschlossen', 'abgeholt', 'archiviert']) {
    db.prepare('UPDATE jobs SET status = ? WHERE id = ?').run(status, jobId);
    const result = listAbgeschlossenJobsForPerson(db, '3');
    assert.equal(result.length, 1, `expected a match for status ${status}`);
    assert.equal(result[0].id, jobId);
  }
  db.close();
});

test('listAbgeschlossenJobsForPerson matches a job by zugewiesen_an even when the person is not the Konto\'s freigeber2', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db); // freigeber1Id: '1', freigeber2Id: '3'
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  setKontierung(db, jobId, kontoId);
  db.prepare("UPDATE jobs SET status = 'abgeschlossen', zugewiesen_an = '1' WHERE id = ?").run(jobId);

  assert.equal(listAbgeschlossenJobsForPerson(db, '1').length, 1);
  db.close();
});

test('listAbgeschlossenJobsForPerson caps the list at 50 rows and returns the newest ones', () => {
  // Completed invoices only ever accumulate, and this list feeds the most-visited page in the
  // app (/pool) — without the LIMIT it would grow unbounded for the lifetime of the install.
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db); // freigeber2Id: '3'
  // 60 jobs with strictly increasing eingang_am, so "newest first" is unambiguous.
  const ids = [];
  for (let i = 0; i < 60; i += 1) {
    const eingangAm = new Date(Date.UTC(2026, 0, 1, 0, i, 0)).toISOString();
    const jobId = createJob(db, { eingangAm, quelle: 'scanner', absender: null, dateiname: `a${i}.pdf`, pdfPfad: '/tmp/a.pdf' });
    setKontierung(db, jobId, kontoId);
    db.prepare("UPDATE jobs SET status = 'abgeschlossen' WHERE id = ?").run(jobId);
    ids.push(jobId);
  }

  const result = listAbgeschlossenJobsForPerson(db, '3');
  assert.equal(result.length, 50, 'the query must cap at 50 rows, not return all 60');
  assert.equal(result[0].id, ids[59], 'newest (highest eingang_am) first');
  assert.equal(result[49].id, ids[10], 'the 50 newest are kept — the 10 oldest are what falls off');
  db.close();
});

test('listAbgeschlossenJobsForPerson excludes a job that has not reached abgeschlossen yet', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db); // freigeber2Id: '3'
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  setKontierung(db, jobId, kontoId);
  db.prepare("UPDATE jobs SET status = 'freigabe2' WHERE id = ?").run(jobId);

  assert.equal(listAbgeschlossenJobsForPerson(db, '3').length, 0);
  db.close();
});

test('listAbgeschlossenJobsForPerson excludes a job that has been admin-escalated past the excluded stellvertreter2, even once it reaches abgeschlossen', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db); // freigeber2Id: '3', stellvertreter2Id: '4'
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  setKontierung(db, jobId, kontoId);
  db.prepare("UPDATE jobs SET status = 'freigabe2' WHERE id = ?").run(jobId);
  eskalierenFreigabe2(db, jobId, { eskaliertVon: '3', grund: 'Befangen' });
  eskalierenFreigabe2AnAdmin(db, jobId, { eskaliertVon: '4', grund: 'Auch befangen' });
  // Carried to abgeschlossen directly (bypassing abschliessenFreigabe2, which would otherwise
  // clear freigabe2_eskaliert_an_admin) so the query's guard is exercised on its own merits,
  // matching listFreigabe2JobsForPerson's admin-escalation exclusion.
  db.prepare("UPDATE jobs SET status = 'abgeschlossen' WHERE id = ?").run(jobId);

  assert.equal(listAbgeschlossenJobsForPerson(db, '3').length, 0);
  assert.equal(listAbgeschlossenJobsForPerson(db, '4').length, 0);
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

test('ablehnenJob sets status to abgelehnt with the rejection reason when the job is in zugewiesen (Kontierung-stage rejection, before any Konto is chosen)', () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'Frei', nachname: 'Geber', email: 'frei@example.org', gruppen: [], loggedInNow: false });
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, jobId, '1');

  const result = ablehnenJob(db, jobId, { abgelehntVon: '1', grund: 'Duplikat' });
  assert.equal(result, true);
  const job = getJobById(db, jobId);
  assert.equal(job.status, 'abgelehnt');
  assert.equal(job.abgelehnt_von, '1');
  assert.equal(job.ablehnungsgrund, 'Duplikat');
  db.close();
});

test('ablehnenJob refuses to reject a job that is still unzugewiesen (not yet claimed)', () => {
  const db = openDatabase(':memory:');
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  const result = ablehnenJob(db, jobId, { abgelehntVon: '1', grund: 'zu spät' });
  assert.equal(result, false);
  assert.equal(getJobById(db, jobId).status, 'unzugewiesen');
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

test('listAbgelehntJobsForPerson excludes a job that has been admin-escalated past this person', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, jobId, '1');
  setKontierung(db, jobId, kontoId);
  db.prepare("UPDATE jobs SET status = 'freigabe2' WHERE id = ?").run(jobId);
  eskalierenFreigabe1AnAdmin(db, jobId, { eskaliertVon: '2', grund: 'Auch befangen' });
  ablehnenJob(db, jobId, { abgelehntVon: '3', grund: 'Falsches Konto' });

  // zugewiesen_an still equals '1', but the job was escalated to Portal-Admin before it ever
  // reached Freigabe 2 — it must not show up in the excluded original assignee's own listing.
  assert.equal(listAbgelehntJobsForPerson(db, '1').length, 0);
  db.close();
});

test('listAlleAbgelehntenJobs returns abgelehnt jobs regardless of who they are assigned to (admin-wide)', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const jobId1 = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, jobId1, '1');
  setKontierung(db, jobId1, kontoId);
  db.prepare("UPDATE jobs SET status = 'freigabe2' WHERE id = ?").run(jobId1);
  ablehnenJob(db, jobId1, { abgelehntVon: '3', grund: 'Falsches Konto' });

  const jobId2 = createJob(db, { eingangAm: '2026-08-15T09:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'b.pdf', pdfPfad: '/tmp/b.pdf' });
  claimJob(db, jobId2, '2');
  ablehnenJob(db, jobId2, { abgelehntVon: '2', grund: 'Duplikat' });

  const openJobId = createJob(db, { eingangAm: '2026-08-15T10:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'c.pdf', pdfPfad: '/tmp/c.pdf' });
  claimJob(db, openJobId, '1');

  const rows = listAlleAbgelehntenJobs(db);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.id).sort(), [jobId1, jobId2].sort());
  db.close();
});

test('loeschenJob soft-deletes the job (status "geloescht"), keeps its freigaben, and returns the pre-deletion row', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, jobId, '1');
  setKontierung(db, jobId, kontoId);
  db.prepare("UPDATE jobs SET status = 'freigabe2' WHERE id = ?").run(jobId);
  ablehnenJob(db, jobId, { abgelehntVon: '3', grund: 'Falsches Konto' });
  createFreigabe(db, { jobId, personId: '3', rolle: 'ablehnung', zeitpunkt: '2026-08-15T09:00:00.000Z', ip: '1.2.3.4', interessenskonflikt: false, kommentar: 'Falsches Konto', eskaliertVon: null });

  const result = loeschenJob(db, jobId);
  assert.equal(result.id, jobId);
  assert.equal(result.dateiname, 'a.pdf');
  const job = getJobById(db, jobId);
  assert.ok(job, 'the job row should survive a "deletion" as an archived record');
  assert.equal(job.status, 'geloescht');
  assert.equal(listFreigabenByJob(db, jobId).length, 1, 'the freigaben audit trail should be kept');
  db.close();
});

test('loeschenJob refuses to delete a job that is not abgelehnt', () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'Frei', nachname: 'Geber', email: 'frei@example.org', gruppen: [], loggedInNow: false });
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, jobId, '1');
  const result = loeschenJob(db, jobId);
  assert.equal(result, null);
  assert.ok(getJobById(db, jobId));
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

test('releaseJob stores an optional hinweisKontoId so the Pool can show which Konto this invoice is probably meant for', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const anderesKontoId = createKonto(db, { kontonummer: '4200', bezeichnung: 'Kinderbereich', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare("UPDATE jobs SET status = 'zugewiesen', zugewiesen_an = '1', konto_id = ? WHERE id = ?").run(kontoId, jobId);

  releaseJob(db, jobId, '1', { hinweisKontoId: anderesKontoId });
  const job = getJobById(db, jobId);
  assert.equal(job.status, 'unzugewiesen');
  assert.equal(job.hinweis_konto_id, anderesKontoId);
  db.close();
});

test('releaseJob defaults hinweis_konto_id to null when no hint is given', () => {
  const db = openDatabase(':memory:');
  seedKonto(db);
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, jobId, '1');

  releaseJob(db, jobId, '1');
  assert.equal(getJobById(db, jobId).hinweis_konto_id, null);
  db.close();
});

test('releaseJob clears a stale hinweis_konto_id from a prior release cycle when the new one carries no hint', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const anderesKontoId = createKonto(db, { kontonummer: '4200', bezeichnung: 'Kinderbereich', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare("UPDATE jobs SET status = 'zugewiesen', zugewiesen_an = '1', konto_id = ? WHERE id = ?").run(kontoId, jobId);
  releaseJob(db, jobId, '1', { hinweisKontoId: anderesKontoId });

  // Someone claims the mis-hinted job, realizes the hint was itself wrong, and releases it again
  // without one -- releaseJob is documented as a "genuine fresh start", so the stale hint must
  // not silently survive into the next pool cycle.
  claimJob(db, jobId, '2');
  releaseJob(db, jobId, '2');
  assert.equal(getJobById(db, jobId).hinweis_konto_id, null);
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

test('markZeitstempelGesetzt sets zeitstempel_gesetzt_am, leaves it null until called', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const jobId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare('UPDATE jobs SET konto_id = ? WHERE id = ?').run(kontoId, jobId);

  assert.equal(getJobById(db, jobId).zeitstempel_gesetzt_am, null);
  markZeitstempelGesetzt(db, jobId, '2026-08-21T10:00:00.000Z');
  assert.equal(getJobById(db, jobId).zeitstempel_gesetzt_am, '2026-08-21T10:00:00.000Z');
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

test('listAdminEskalierteKontierungen finds a zugewiesen job escalated to admin, excludes a normal zugewiesen job and a resolved one', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const eskaliert = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare("UPDATE jobs SET status = 'zugewiesen', zugewiesen_an = '2', konto_id = ? WHERE id = ?").run(kontoId, eskaliert);
  eskalierenFreigabe1AnAdmin(db, eskaliert, { eskaliertVon: '2', grund: 'Auch befangen' });

  const normal = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'b.pdf', pdfPfad: '/tmp/b.pdf' });
  db.prepare("UPDATE jobs SET status = 'zugewiesen', zugewiesen_an = '1', konto_id = ? WHERE id = ?").run(kontoId, normal);

  const resolved = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'c.pdf', pdfPfad: '/tmp/c.pdf' });
  db.prepare("UPDATE jobs SET status = 'freigabe2', konto_id = ? WHERE id = ?").run(kontoId, resolved);

  const result = listAdminEskalierteKontierungen(db);
  assert.deepEqual(result.map((j) => j.id), [eskaliert]);
  db.close();
});

test('listAdminEskalierteFreigaben finds a freigabe2 job escalated to admin, excludes a normal freigabe2 job', () => {
  const db = openDatabase(':memory:');
  seedKonto(db);
  const eskaliert = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare("UPDATE jobs SET status = 'freigabe2' WHERE id = ?").run(eskaliert);
  eskalierenFreigabe2AnAdmin(db, eskaliert, { eskaliertVon: '4', grund: 'Auch befangen' });

  const normal = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'b.pdf', pdfPfad: '/tmp/b.pdf' });
  db.prepare("UPDATE jobs SET status = 'freigabe2' WHERE id = ?").run(normal);

  const result = listAdminEskalierteFreigaben(db);
  assert.deepEqual(result.map((j) => j.id), [eskaliert]);
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

test('markJobAufgesplittet sets status to aufgesplittet only from zugewiesen', () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'Frei', nachname: 'Geber', email: 'frei@example.org', gruppen: [], loggedInNow: false });
  const jobId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, jobId, '1');
  assert.equal(markJobAufgesplittet(db, jobId), true);
  assert.equal(getJobById(db, jobId).status, 'aufgesplittet');
  assert.equal(markJobAufgesplittet(db, jobId), false, 'a job already aufgesplittet cannot be split again');
  db.close();
});

test('createSplitJob creates an independent job carrying over the parent\'s shared fields, and listSplitKinder finds it', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const debitorId = seedDebitorMitKonto(db, kontoId);
  const parentId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'lieferant', absender: 'lief@example.org', dateiname: 'rechnung.pdf', pdfPfad: '/tmp/a.pdf' });
  updateKontierungMetadaten(db, parentId, { absender: 'lief@example.org', betrag: '200.00', zahlungsziel: '2026-09-01', rechnungsnummer: 'RE-1', lieferant: 'Muster AG', debitorId });
  const parentJob = getJobById(db, parentId);

  const kindId = createSplitJob(db, parentJob, { pdfPfad: '/tmp/split-a.pdf', thumbnailPfad: '/tmp/split-a.png', kontoId, betrag: '100.00', zugewiesenAn: '1' });
  const kind = getJobById(db, kindId);

  assert.equal(kind.status, 'zugewiesen');
  assert.equal(kind.pdf_pfad, '/tmp/split-a.pdf');
  assert.equal(kind.thumbnail_pfad, '/tmp/split-a.png');
  assert.equal(kind.konto_id, kontoId);
  assert.equal(kind.zugewiesen_an, '1');
  assert.equal(kind.betrag, '100.00');
  assert.equal(kind.zahlungsziel, '2026-09-01');
  assert.equal(kind.rechnungsnummer, 'RE-1');
  assert.equal(kind.lieferant, 'Muster AG');
  assert.equal(kind.debitor_id, debitorId);
  assert.equal(kind.aufgesplittet_von, parentId);
  assert.equal(kind.dateiname, 'rechnung.pdf');
  assert.equal(kind.absender, 'lief@example.org');

  const kinder = listSplitKinder(db, parentId);
  assert.equal(kinder.length, 1);
  assert.equal(kinder[0].id, kindId);
  db.close();
});

test('setQrDaten stores the decoded QR-bill fields and sets qr_erkannt_am', () => {
  const db = openDatabase(':memory:');
  const id = createJob(db, { eingangAm: '2026-08-22T08:00:00.000Z', quelle: 'lieferant', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  setQrDaten(db, id, {
    qrIban: 'CH4431999123000889012',
    qrReferenz: '210000000003139471430009017',
    qrBetrag: '1949.75',
    qrWaehrung: 'CHF',
    qrCreditorName: 'Muster AG',
  });
  const job = getJobById(db, id);
  assert.equal(job.qr_iban, 'CH4431999123000889012');
  assert.equal(job.qr_referenz, '210000000003139471430009017');
  assert.equal(job.qr_betrag, '1949.75');
  assert.equal(job.qr_waehrung, 'CHF');
  assert.equal(job.qr_creditor_name, 'Muster AG');
  assert.ok(job.qr_erkannt_am, 'qr_erkannt_am should be set');
  db.close();
});
