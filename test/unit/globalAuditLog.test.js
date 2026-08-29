import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createJob, setKontierung } from '../../src/db/jobsRepo.js';
import { createKonto } from '../../src/db/kontenRepo.js';
import { createFreigabe } from '../../src/db/freigabenRepo.js';
import { logJobLoeschung } from '../../src/db/jobLoeschungenRepo.js';
import { queryGlobalAuditLog } from '../../src/services/globalAuditLog.js';

function seedGrundstock(db) {
  upsertPerson(db, { id: '1', vorname: 'Frei', nachname: 'Geber', email: 'f@example.org', gruppen: [], loggedInNow: false });
  upsertPerson(db, { id: '2', vorname: 'Andrea', nachname: 'Admin', email: 'a@example.org', gruppen: [], loggedInNow: false });
  const kontoId = createKonto(db, { kontonummer: '1000', bezeichnung: 'Büromaterial', freigeber1Id: '1', stellvertreter1Id: '1', freigeber2Id: '2', stellvertreter2Id: '2' });
  return { kontoId };
}

test('queryGlobalAuditLog merges freigaben and job_loeschungen, sorted zeitpunkt DESC, with no filter', () => {
  const db = openDatabase(':memory:');
  const { kontoId } = seedGrundstock(db);
  const jobA = createJob(db, { eingangAm: '2026-08-01T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  setKontierung(db, jobA, kontoId);
  createFreigabe(db, { jobId: jobA, personId: '1', rolle: 'freigeber1', zeitpunkt: '2026-08-01T09:00:00.000Z', ip: '127.0.0.1', interessenskonflikt: false, kommentar: 'ok', eskaliertVon: null });
  const jobB = createJob(db, { eingangAm: '2026-08-02T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'b.pdf', pdfPfad: '/tmp/b.pdf' });
  logJobLoeschung(db, { jobId: jobB, dateiname: 'b.pdf', geloeschtVon: '2', begruendung: 'Duplikat' });

  const { eintraege, gesamtAnzahl } = queryGlobalAuditLog(db);
  assert.equal(gesamtAnzahl, 2);
  assert.equal(eintraege.length, 2);
  assert.equal(eintraege[0].dateiname, 'b.pdf', 'the later job_loeschungen row must come first (DESC)');
  assert.equal(eintraege[0].ereignis, 'Job gelöscht');
  assert.equal(eintraege[0].person, 'Andrea Admin');
  assert.equal(eintraege[0].kommentar, 'Duplikat');
  assert.equal(eintraege[1].dateiname, 'a.pdf');
  assert.equal(eintraege[1].ereignis, 'Freigabe 1 erteilt');
  assert.equal(eintraege[1].kontoBezeichnung, 'Büromaterial');
  db.close();
});

test('queryGlobalAuditLog filters by personId (the acting person on both sources)', () => {
  const db = openDatabase(':memory:');
  seedGrundstock(db);
  const jobA = createJob(db, { eingangAm: '2026-08-01T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  createFreigabe(db, { jobId: jobA, personId: '1', rolle: 'freigeber1', zeitpunkt: '2026-08-01T09:00:00.000Z', ip: '127.0.0.1', interessenskonflikt: false, kommentar: null, eskaliertVon: null });
  const jobB = createJob(db, { eingangAm: '2026-08-02T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'b.pdf', pdfPfad: '/tmp/b.pdf' });
  logJobLoeschung(db, { jobId: jobB, dateiname: 'b.pdf', geloeschtVon: '2', begruendung: 'Duplikat' });

  const { eintraege } = queryGlobalAuditLog(db, { personId: '2' });
  assert.equal(eintraege.length, 1);
  assert.equal(eintraege[0].dateiname, 'b.pdf');
  db.close();
});

test('queryGlobalAuditLog filters by kontoId', () => {
  const db = openDatabase(':memory:');
  const { kontoId } = seedGrundstock(db);
  const jobMitKonto = createJob(db, { eingangAm: '2026-08-01T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'mit-konto.pdf', pdfPfad: '/tmp/x.pdf' });
  setKontierung(db, jobMitKonto, kontoId);
  createFreigabe(db, { jobId: jobMitKonto, personId: '1', rolle: 'freigeber1', zeitpunkt: '2026-08-01T09:00:00.000Z', ip: '127.0.0.1', interessenskonflikt: false, kommentar: null, eskaliertVon: null });
  const jobOhneKonto = createJob(db, { eingangAm: '2026-08-02T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'ohne-konto.pdf', pdfPfad: '/tmp/y.pdf' });
  createFreigabe(db, { jobId: jobOhneKonto, personId: '1', rolle: 'freigeber1', zeitpunkt: '2026-08-02T09:00:00.000Z', ip: '127.0.0.1', interessenskonflikt: false, kommentar: null, eskaliertVon: null });

  const { eintraege } = queryGlobalAuditLog(db, { kontoId });
  assert.equal(eintraege.length, 1);
  assert.equal(eintraege[0].dateiname, 'mit-konto.pdf');
  db.close();
});

test('queryGlobalAuditLog filters by von/bis (inclusive) on zeitpunkt', () => {
  const db = openDatabase(':memory:');
  seedGrundstock(db);
  const job = createJob(db, { eingangAm: '2026-08-01T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  createFreigabe(db, { jobId: job, personId: '1', rolle: 'freigeber1', zeitpunkt: '2026-08-01T09:00:00.000Z', ip: '127.0.0.1', interessenskonflikt: false, kommentar: null, eskaliertVon: null });
  createFreigabe(db, { jobId: job, personId: '1', rolle: 'freigeber2', zeitpunkt: '2026-08-10T09:00:00.000Z', ip: '127.0.0.1', interessenskonflikt: false, kommentar: null, eskaliertVon: null });

  const nurErste = queryGlobalAuditLog(db, { von: '2026-08-01', bis: '2026-08-05' });
  assert.equal(nurErste.eintraege.length, 1);
  assert.equal(nurErste.eintraege[0].ereignis, 'Freigabe 1 erteilt');

  const beide = queryGlobalAuditLog(db, { von: '2026-08-01', bis: '2026-08-10T23:59:59.999Z' });
  assert.equal(beide.eintraege.length, 2);
  db.close();
});

test('queryGlobalAuditLog filters by ereignisTyp, including the loeschung pseudo-type', () => {
  const db = openDatabase(':memory:');
  seedGrundstock(db);
  const jobA = createJob(db, { eingangAm: '2026-08-01T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  createFreigabe(db, { jobId: jobA, personId: '1', rolle: 'freigeber1', zeitpunkt: '2026-08-01T09:00:00.000Z', ip: '127.0.0.1', interessenskonflikt: false, kommentar: null, eskaliertVon: null });
  const jobB = createJob(db, { eingangAm: '2026-08-02T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'b.pdf', pdfPfad: '/tmp/b.pdf' });
  logJobLoeschung(db, { jobId: jobB, dateiname: 'b.pdf', geloeschtVon: '2', begruendung: 'Duplikat' });

  const nurLoeschung = queryGlobalAuditLog(db, { ereignisTyp: 'loeschung' });
  assert.equal(nurLoeschung.eintraege.length, 1);
  assert.equal(nurLoeschung.eintraege[0].dateiname, 'b.pdf');
  db.close();
});

test('queryGlobalAuditLog filters by suchbegriff across kommentar and dateiname (case-insensitive)', () => {
  const db = openDatabase(':memory:');
  seedGrundstock(db);
  const jobA = createJob(db, { eingangAm: '2026-08-01T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'rechnung-swisscom.pdf', pdfPfad: '/tmp/a.pdf' });
  createFreigabe(db, { jobId: jobA, personId: '1', rolle: 'freigeber1', zeitpunkt: '2026-08-01T09:00:00.000Z', ip: '127.0.0.1', interessenskonflikt: false, kommentar: null, eskaliertVon: null });
  const jobB = createJob(db, { eingangAm: '2026-08-02T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'b.pdf', pdfPfad: '/tmp/b.pdf' });
  logJobLoeschung(db, { jobId: jobB, dateiname: 'b.pdf', geloeschtVon: '2', begruendung: 'Verdacht auf Duplikat' });

  const perDateiname = queryGlobalAuditLog(db, { suchbegriff: 'SWISSCOM' });
  assert.equal(perDateiname.eintraege.length, 1);
  assert.equal(perDateiname.eintraege[0].dateiname, 'rechnung-swisscom.pdf');

  const perKommentar = queryGlobalAuditLog(db, { suchbegriff: 'duplikat' });
  assert.equal(perKommentar.eintraege.length, 1);
  assert.equal(perKommentar.eintraege[0].dateiname, 'b.pdf');
  db.close();
});

test('queryGlobalAuditLog paginates: proSeite limits results, seite 2 returns the remainder', () => {
  const db = openDatabase(':memory:');
  seedGrundstock(db);
  const job = createJob(db, { eingangAm: '2026-08-01T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  for (let i = 0; i < 3; i += 1) {
    createFreigabe(db, { jobId: job, personId: '1', rolle: 'freigeber1', zeitpunkt: `2026-08-0${i + 1}T09:00:00.000Z`, ip: '127.0.0.1', interessenskonflikt: false, kommentar: null, eskaliertVon: null });
  }

  const seite1 = queryGlobalAuditLog(db, {}, { seite: 1, proSeite: 2 });
  assert.equal(seite1.eintraege.length, 2);
  assert.equal(seite1.gesamtAnzahl, 3);

  const seite2 = queryGlobalAuditLog(db, {}, { seite: 2, proSeite: 2 });
  assert.equal(seite2.eintraege.length, 1);
  assert.equal(seite2.gesamtAnzahl, 3);
  db.close();
});

test('queryGlobalAuditLog returns an empty result without error when nothing matches', () => {
  const db = openDatabase(':memory:');
  const { eintraege, gesamtAnzahl } = queryGlobalAuditLog(db, { suchbegriff: 'nirgends-vorhanden' });
  assert.deepEqual(eintraege, []);
  assert.equal(gesamtAnzahl, 0);
  db.close();
});
