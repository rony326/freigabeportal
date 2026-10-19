import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createKonto } from '../../src/db/kontenRepo.js';
import { createFreigabe } from '../../src/db/freigabenRepo.js';
import {
  createJob, getJobById, abschliessenFreigabe2, ablehnenJob, eskalierenFreigabe2AnAdmin,
  forceEskalierenFreigabe2AnAdmin, listAbgeschlossenJobsForPerson,
} from '../../src/db/jobsRepo.js';

function seedUmgeleitet(db) {
  for (const id of ['1', '2', '3', '4', '5']) {
    upsertPerson(db, { id, vorname: `P${id}`, nachname: 'M', email: `p${id}@example.org`, gruppen: [], loggedInNow: false });
  }
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'U', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  const jobId = createJob(db, { eingangAm: '2026-10-01T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare("UPDATE jobs SET status = 'freigabe2', konto_id = ?, zugewiesen_an = '1', freigabe2_umgeleitet_an = '5' WHERE id = ?").run(kontoId, jobId);
  return jobId;
}

test('Abschluss löscht die Umleitung', () => {
  const db = openDatabase(':memory:');
  const jobId = seedUmgeleitet(db);
  assert.ok(abschliessenFreigabe2(db, jobId));
  assert.equal(getJobById(db, jobId).freigabe2_umgeleitet_an, null);
  db.close();
});

test('Ablehnung löscht die Umleitung', () => {
  const db = openDatabase(':memory:');
  const jobId = seedUmgeleitet(db);
  assert.ok(ablehnenJob(db, jobId, { abgelehntVon: '5', grund: 'falsch' }));
  assert.equal(getJobById(db, jobId).freigabe2_umgeleitet_an, null);
  db.close();
});

test('Admin-Eskalation (Konflikt und Cron) löscht die Umleitung', () => {
  const db = openDatabase(':memory:');
  const a = seedUmgeleitet(db);
  eskalierenFreigabe2AnAdmin(db, a, { eskaliertVon: '5', grund: 'Konflikt' });
  assert.equal(getJobById(db, a).freigabe2_umgeleitet_an, null);
  const b = createJob(db, { eingangAm: '2026-10-01T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'b.pdf', pdfPfad: '/tmp/b.pdf' });
  db.prepare("UPDATE jobs SET status = 'freigabe2', konto_id = (SELECT konto_id FROM jobs WHERE id = ?), freigabe2_umgeleitet_an = '5' WHERE id = ?").run(a, b);
  assert.ok(forceEskalierenFreigabe2AnAdmin(db, b));
  assert.equal(getJobById(db, b).freigabe2_umgeleitet_an, null);
  db.close();
});

test('Meine abgeschlossenen: wer Freigabe 2 erteilt hat, sieht den Job auch nach gelöschter Umleitung', () => {
  const db = openDatabase(':memory:');
  const jobId = seedUmgeleitet(db);
  createFreigabe(db, { jobId, personId: '5', rolle: 'freigeber2', zeitpunkt: '2026-10-02T08:00:00.000Z', ip: '1.2.3.4', interessenskonflikt: false, kommentar: null, eskaliertVon: null });
  abschliessenFreigabe2(db, jobId);
  assert.deepEqual(listAbgeschlossenJobsForPerson(db, '5').jobs.map((j) => j.id), [jobId]);
  db.close();
});
