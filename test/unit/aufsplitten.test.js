import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson, getPersonById } from '../../src/db/personenRepo.js';
import { createKonto, getKontoById, listKontenForPerson } from '../../src/db/kontenRepo.js';
import { createJob, claimJob, getJobById, markJobAufgesplittet } from '../../src/db/jobsRepo.js';
import { listFreigabenByJob } from '../../src/db/freigabenRepo.js';
import { erzeugeTeilJobs } from '../../src/services/aufsplitten.js';

function setup() {
  const db = openDatabase(':memory:');
  for (const id of ['1', '2', '3', '4', '5', '6']) upsertPerson(db, { id, vorname: `P${id}`, nachname: 'M', email: `p${id}@example.org`, gruppen: [] });
  const eigen = createKonto(db, { kontonummer: '1000', bezeichnung: 'Eigen', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  const fremd = createKonto(db, { kontonummer: '2000', bezeichnung: 'Fremd', freigeber1Id: '5', stellvertreter1Id: '2', freigeber2Id: '6', stellvertreter2Id: '4' });
  const jobId = createJob(db, { eingangAm: '2026-09-27T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'kk.pdf', pdfPfad: '/tmp/kk.pdf' });
  claimJob(db, jobId, '1');
  return { db, eigen, fremd, jobId };
}

test("erzeugeTeilJobs 'freigeber1' mode assigns foreign-Konto lines to that Konto's Freigeber1 instead of the pool", () => {
  const { db, eigen, fremd, jobId } = setup();
  const job = getJobById(db, jobId);
  db.exec('BEGIN');
  markJobAufgesplittet(db, jobId);
  const ergebnis = erzeugeTeilJobs(db, {
    job,
    teile: [
      { konto: getKontoById(db, eigen), betrag: '10.00', interessenskonflikt: false, position: null, pdfPfad: '/tmp/a.pdf', thumbnailPfad: null, belegSeitenzahl: 1, beschreibung: 'Papier' },
      { konto: getKontoById(db, fremd), betrag: '-5.00', interessenskonflikt: false, position: null, pdfPfad: '/tmp/b.pdf', thumbnailPfad: null, belegSeitenzahl: null, typ: 'gutschrift', beschreibung: 'Rückerstattung', kkEigenbelegGrund: 'Beleg verloren' },
    ],
    konten: listKontenForPerson(db, '1'),
    person: getPersonById(db, '1'),
    ip: '::1',
    begruendung: '',
    fremdKontoModus: 'freigeber1',
    istVertretung: false,
  });
  db.exec('COMMIT');
  assert.equal(ergebnis.selbstFreigegeben.length, 1);
  assert.equal(ergebnis.anFreigeber1.length, 1);
  assert.equal(ergebnis.fremdeKonten.length, 0);
  const eigenKind = getJobById(db, ergebnis.selbstFreigegeben[0].id);
  assert.equal(eigenKind.status, 'freigabe2');
  assert.equal(eigenKind.beschreibung, 'Papier');
  const fremdKind = getJobById(db, ergebnis.anFreigeber1[0].id);
  assert.equal(fremdKind.status, 'zugewiesen');
  assert.equal(fremdKind.zugewiesen_an, '5');
  assert.equal(fremdKind.konto_id, fremd);
  assert.equal(fremdKind.typ, 'gutschrift');
  assert.equal(fremdKind.kk_eigenbeleg_grund, 'Beleg verloren');
  assert.equal(fremdKind.aufgesplittet_von, jobId);
  assert.equal(listFreigabenByJob(db, fremdKind.id).length, 0);
  db.close();
});

test("erzeugeTeilJobs 'pool' mode keeps today's behavior: foreign-Konto lines go unzugewiesen with a Hinweis-Konto", () => {
  const { db, fremd, jobId } = setup();
  const job = getJobById(db, jobId);
  db.exec('BEGIN');
  markJobAufgesplittet(db, jobId);
  const ergebnis = erzeugeTeilJobs(db, {
    job,
    teile: [{ konto: getKontoById(db, fremd), betrag: '10.00', interessenskonflikt: false, position: null, pdfPfad: '/tmp/a.pdf', thumbnailPfad: null, belegSeitenzahl: null }],
    konten: listKontenForPerson(db, '1'),
    person: getPersonById(db, '1'),
    ip: '::1',
    begruendung: '',
    fremdKontoModus: 'pool',
    istVertretung: false,
  });
  db.exec('COMMIT');
  const kind = getJobById(db, ergebnis.fremdeKonten[0].id);
  assert.equal(kind.status, 'unzugewiesen');
  assert.equal(kind.hinweis_konto_id, fremd);
  db.close();
});
