import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { createJob } from '../../src/db/jobsRepo.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createFreigabe } from '../../src/db/freigabenRepo.js';
import { ausschlussGrundFuerEskalationsziel, grundMitAusschluss } from '../../src/services/eskalationsZiel.js';

function setup() {
  const db = openDatabase(':memory:');
  for (const id of ['1', '2', '3']) upsertPerson(db, { id, vorname: 'P', nachname: id, email: `p${id}@example.org`, gruppen: [] });
  const jobId = createJob(db, { eingangAm: '2026-10-01T00:00:00Z', quelle: 'scanner', dateiname: 'r.pdf', pdfPfad: '/tmp/r.pdf' });
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  return { db, job };
}

function freigabe(db, jobId, personId, rolle) {
  createFreigabe(db, { jobId, personId, rolle, zeitpunkt: new Date().toISOString(), ip: '::1', interessenskonflikt: rolle.endsWith('eskalation'), kommentar: 'x', eskaliertVon: null });
}

test('a Stellvertretung without any exclusion is a valid escalation target', (t) => {
  const { db, job } = setup();
  t.after(() => db.close());
  assert.equal(ausschlussGrundFuerEskalationsziel(db, job, { stufe: 1, zielId: '2', meldenderId: '1' }), null);
  assert.equal(ausschlussGrundFuerEskalationsziel(db, job, { stufe: 2, zielId: '2', meldenderId: '1' }), null);
});

test('missing Stellvertretung and self-escalation are excluded', (t) => {
  const { db, job } = setup();
  t.after(() => db.close());
  assert.match(ausschlussGrundFuerEskalationsziel(db, job, { stufe: 1, zielId: null, meldenderId: '1' }), /keine Stellvertretung/);
  assert.match(ausschlussGrundFuerEskalationsziel(db, job, { stufe: 1, zielId: '1', meldenderId: '1' }), /meldende Person/);
});

test('a person who already declared a conflict on the same stage is excluded, on the other stage not', (t) => {
  const { db, job } = setup();
  t.after(() => db.close());
  freigabe(db, job.id, '2', 'freigabe1_eskalation');
  assert.match(ausschlussGrundFuerEskalationsziel(db, job, { stufe: 1, zielId: '2', meldenderId: '3' }), /Interessenskonflikt/);
  assert.equal(ausschlussGrundFuerEskalationsziel(db, job, { stufe: 2, zielId: '2', meldenderId: '3' }), null);
});

test('at Freigabe 2 the person who granted Freigabe 1 is excluded (Vier-Augen-Prinzip)', (t) => {
  const { db, job } = setup();
  t.after(() => db.close());
  freigabe(db, job.id, '2', 'freigeber1');
  assert.match(ausschlussGrundFuerEskalationsziel(db, job, { stufe: 2, zielId: '2', meldenderId: '3' }), /Freigabe 1/);
  assert.equal(ausschlussGrundFuerEskalationsziel(db, job, { stufe: 1, zielId: '2', meldenderId: '3' }), null);
});

test('the submitter of a Spesen position is excluded', (t) => {
  const { db, job } = setup();
  t.after(() => db.close());
  const spesenJob = { ...job, quelle: 'spesen', eingereicht_von: '2' };
  assert.match(ausschlussGrundFuerEskalationsziel(db, spesenJob, { stufe: 1, zielId: '2', meldenderId: '3' }), /selbst eingereicht/);
});

test('grundMitAusschluss appends the exclusion reason only when there is one', () => {
  assert.equal(grundMitAusschluss('Verwandt', null), 'Verwandt');
  assert.equal(grundMitAusschluss('Verwandt', 'hat bereits Freigabe 1 erteilt'), 'Verwandt — Stellvertretung ausgeschlossen (hat bereits Freigabe 1 erteilt)');
});
