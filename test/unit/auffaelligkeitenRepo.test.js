import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createJob } from '../../src/db/jobsRepo.js';
import { speichereBestaetigung, listBestaetigungen, letzteBestaetigung } from '../../src/db/auffaelligkeitenRepo.js';

function aufbau() {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'Erika', nachname: 'Muster', email: 'e@example.org', gruppen: ['10'], loggedInNow: true });
  const jobId = createJob(db, { eingangAm: '2026-11-10T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  return { db, jobId };
}

const BEFUND = { code: 'iban_fremd', schwere: 'rot', titel: 'IBAN nicht hinterlegt', text: 'x' };

test('speichereBestaetigung legt eine Zeile an; list/letzte liefern die Befunde, neueste zuerst', () => {
  const { db, jobId } = aufbau();
  assert.equal(letzteBestaetigung(db, jobId), null);
  const erste = speichereBestaetigung(db, { jobId, personId: '1', befunde: [BEFUND], bemerkung: 'telefonisch' });
  const zweite = speichereBestaetigung(db, { jobId, personId: '1', befunde: [], bemerkung: '' });
  const liste = listBestaetigungen(db, jobId);
  assert.deepEqual(liste.map((b) => b.id), [zweite, erste]);
  assert.deepEqual(liste[1].befunde, [BEFUND]);
  assert.equal(liste[1].bemerkung, 'telefonisch');
  assert.equal(liste[0].bemerkung, null);
  assert.equal(liste[0].befunde_json, undefined);
  assert.equal(letzteBestaetigung(db, jobId).id, zweite);
  db.close();
});

test('kontierung_auffaelligkeiten ist unveränderlich und erscheint im Audit', () => {
  const { db, jobId } = aufbau();
  const id = speichereBestaetigung(db, { jobId, personId: '1', befunde: [BEFUND] });
  assert.throws(() => db.prepare("UPDATE kontierung_auffaelligkeiten SET bemerkung = 'x' WHERE id = ?").run(id), /unveraenderlich/);
  assert.throws(() => db.prepare('DELETE FROM kontierung_auffaelligkeiten WHERE id = ?').run(id), /unveraenderlich/);
  const audit = db.prepare("SELECT aktion FROM audit_ereignisse WHERE objekt = 'kontierung_auffaelligkeiten' AND objekt_id = ?").all(String(id));
  assert.deepEqual(audit.map((a) => a.aktion), ['INSERT']);
  db.close();
});
