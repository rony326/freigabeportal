import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createKonto, getKontoById } from '../../src/db/kontenRepo.js';
import { createJob, getJobById } from '../../src/db/jobsRepo.js';
import { createFreigabe } from '../../src/db/freigabenRepo.js';
import { ermittleStriktesWeiterleitungsZiel } from '../../src/services/kontierungZugriff.js';

function setup() {
  const db = openDatabase(':memory:');
  for (const id of ['1', '2', '3', '4', '5']) {
    upsertPerson(db, { id, vorname: `P${id}`, nachname: 'M', email: `p${id}@example.org`, gruppen: [], loggedInNow: false });
  }
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'U', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  const jobId = createJob(db, { eingangAm: '2026-10-01T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare("UPDATE jobs SET status = 'zugewiesen', konto_id = ?, zugewiesen_an = '5' WHERE id = ?").run(kontoId, jobId);
  return { db, kontoId, jobId };
}

function konflikt(db, jobId, personId) {
  createFreigabe(db, { jobId, personId, rolle: 'freigabe1_eskalation', zeitpunkt: '2026-10-01T09:00:00.000Z', ip: '1', interessenskonflikt: true, kommentar: 'x', eskaliertVon: null });
}

function ziel(db, kontoId, jobId) {
  return ermittleStriktesWeiterleitungsZiel(db, getJobById(db, jobId), getKontoById(db, kontoId), '5');
}

test('normal: Weiterleitung an Freigeber 1', () => {
  const { db, kontoId, jobId } = setup();
  assert.deepEqual(ziel(db, kontoId, jobId), { personId: '1' });
  db.close();
});

test('Freigeber 1 hat Konflikt erklärt: Weiterleitung an Stellvertreter 1', () => {
  const { db, kontoId, jobId } = setup();
  konflikt(db, jobId, '1');
  db.prepare("UPDATE jobs SET freigabe1_eskaliert_von = '1' WHERE id = ?").run(jobId);
  assert.deepEqual(ziel(db, kontoId, jobId), { personId: '2' });
  db.close();
});

test('Freigeber 1 und Stellvertreter 1 haben Konflikt erklärt: Admin-Gruppe', () => {
  const { db, kontoId, jobId } = setup();
  konflikt(db, jobId, '1');
  konflikt(db, jobId, '2');
  db.prepare("UPDATE jobs SET freigabe1_eskaliert_von = '2' WHERE id = ?").run(jobId);
  assert.deepEqual(ziel(db, kontoId, jobId), { anAdmin: true });
  db.close();
});

test('primäre Person inaktiv: die andere wird gewählt', () => {
  const { db, kontoId, jobId } = setup();
  db.prepare("UPDATE personen SET aktiv = 0 WHERE churchtools_person_id = '1'").run();
  assert.deepEqual(ziel(db, kontoId, jobId), { personId: '2' });
  db.close();
});

test('aktuelle Person wird nie Ziel', () => {
  const { db, kontoId, jobId } = setup();
  assert.deepEqual(ermittleStriktesWeiterleitungsZiel(db, getJobById(db, jobId), getKontoById(db, kontoId), '1'), { personId: '2' });
  db.close();
});
