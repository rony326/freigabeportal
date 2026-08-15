import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createKonto } from '../../src/db/kontenRepo.js';
import { createJob } from '../../src/db/jobsRepo.js';
import { createFreigabe, listFreigabenByJob } from '../../src/db/freigabenRepo.js';

function seedJob(db) {
  for (const id of ['1', '2', '3', '4']) {
    upsertPerson(db, { id, vorname: `Person${id}`, nachname: 'Muster', email: `p${id}@example.org`, gruppen: ['10'], loggedInNow: false });
  }
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  return { kontoId, jobId };
}

test('createFreigabe inserts a row with all fields, listFreigabenByJob returns it', () => {
  const db = openDatabase(':memory:');
  const { jobId } = seedJob(db);
  const id = createFreigabe(db, {
    jobId,
    personId: '1',
    rolle: 'freigeber1',
    zeitpunkt: '2026-08-15T09:00:00.000Z',
    ip: '1.2.3.4',
    interessenskonflikt: false,
    kommentar: null,
    eskaliertVon: null,
  });
  assert.equal(typeof id, 'number');
  const rows = listFreigabenByJob(db, jobId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].person_id, '1');
  assert.equal(rows[0].rolle, 'freigeber1');
  assert.equal(rows[0].zeitpunkt, '2026-08-15T09:00:00.000Z');
  assert.equal(rows[0].ip, '1.2.3.4');
  assert.equal(rows[0].interessenskonflikt, 0);
  assert.equal(rows[0].kommentar, null);
  assert.equal(rows[0].eskaliert_von, null);
  db.close();
});

test('createFreigabe records interessenskonflikt, kommentar and eskaliertVon when set', () => {
  const db = openDatabase(':memory:');
  const { jobId } = seedJob(db);
  createFreigabe(db, {
    jobId,
    personId: '2',
    rolle: 'freigeber1',
    zeitpunkt: '2026-08-15T09:00:00.000Z',
    ip: '1.2.3.4',
    interessenskonflikt: true,
    kommentar: 'Verwandtschaft mit Lieferant',
    eskaliertVon: '1',
  });
  const rows = listFreigabenByJob(db, jobId);
  assert.equal(rows[0].interessenskonflikt, 1);
  assert.equal(rows[0].kommentar, 'Verwandtschaft mit Lieferant');
  assert.equal(rows[0].eskaliert_von, '1');
  db.close();
});

test('listFreigabenByJob only returns rows for the given job', () => {
  const db = openDatabase(':memory:');
  const { jobId } = seedJob(db);
  const otherJobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'b.pdf', pdfPfad: '/tmp/b.pdf' });
  createFreigabe(db, { jobId, personId: '1', rolle: 'freigeber1', zeitpunkt: '2026-08-15T09:00:00.000Z', ip: '1.2.3.4', interessenskonflikt: false, kommentar: null, eskaliertVon: null });
  createFreigabe(db, { jobId: otherJobId, personId: '3', rolle: 'freigeber1', zeitpunkt: '2026-08-15T09:00:00.000Z', ip: '5.6.7.8', interessenskonflikt: false, kommentar: null, eskaliertVon: null });
  assert.equal(listFreigabenByJob(db, jobId).length, 1);
  assert.equal(listFreigabenByJob(db, otherJobId).length, 1);
  db.close();
});
