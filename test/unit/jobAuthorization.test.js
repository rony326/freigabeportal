import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson, getPersonById } from '../../src/db/personenRepo.js';
import { setFerienmodus } from '../../src/db/personenRepo.js';
import { createKonto } from '../../src/db/kontenRepo.js';
import { createJob, claimJob, setKontierung } from '../../src/db/jobsRepo.js';
import { canViewJobPdf } from '../../src/services/jobAuthorization.js';

function config() {
  return { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20' } };
}

function seedKontoUndPersonen(db) {
  for (const id of ['1', '2', '3', '4']) {
    upsertPerson(db, { id, vorname: `Person${id}`, nachname: 'Muster', email: `p${id}@example.org`, gruppen: ['10'], loggedInNow: true });
  }
  return createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
}

test('canViewJobPdf allows the active Stellvertreter of zugewiesen_an on a zugewiesen job', () => {
  const db = openDatabase(':memory:');
  seedKontoUndPersonen(db);
  setFerienmodus(db, '1', { von: '2000-01-01', bis: '2999-01-01', stellvertreterId: '2' });
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, jobId, '1');
  const job = { id: jobId, status: 'zugewiesen', zugewiesen_an: '1', eingereicht_von: null, konto_id: null };

  assert.equal(canViewJobPdf(db, config(), getPersonById(db, '2'), job), true);
  db.close();
});

test('canViewJobPdf denies someone who is not (yet/anymore) an active Stellvertreter', () => {
  const db = openDatabase(':memory:');
  seedKontoUndPersonen(db);
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, jobId, '1');
  const job = { id: jobId, status: 'zugewiesen', zugewiesen_an: '1', eingereicht_von: null, konto_id: null };

  assert.equal(canViewJobPdf(db, config(), getPersonById(db, '2'), job), false);
  db.close();
});

test('canViewJobPdf allows the active Stellvertreter of the effective Freigeber2 on a freigabe2 job', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKontoUndPersonen(db); // freigeber2Id: '3'
  setFerienmodus(db, '3', { von: '2000-01-01', bis: '2999-01-01', stellvertreterId: '1' });
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  setKontierung(db, jobId, kontoId);
  const job = { id: jobId, status: 'freigabe2', zugewiesen_an: null, eingereicht_von: null, konto_id: kontoId, freigabe2_eskaliert_von: null };

  assert.equal(canViewJobPdf(db, config(), getPersonById(db, '1'), job), true);
  db.close();
});
