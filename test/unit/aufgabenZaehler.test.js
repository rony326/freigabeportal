import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { seedDefaults } from '../../src/db/adminConfigRepo.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createKonto } from '../../src/db/kontenRepo.js';
import { createJob, claimJob, setKontierung } from '../../src/db/jobsRepo.js';
import { zaehleOffeneAufgaben } from '../../src/services/aufgabenZaehler.js';
import { loadNavFlags } from '../../src/middleware/nav.js';

function setup() {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  for (const id of ['50', '1', '2', '3']) {
    upsertPerson(db, { id, vorname: `P${id}`, nachname: 'Muster', email: `${id}@example.org`, gruppen: ['10'], loggedInNow: false });
  }
  return db;
}

const neuerJob = (db, name) =>
  createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: name, pdfPfad: '/tmp/a.pdf' });

test('zaehleOffeneAufgaben liefert 0 ohne Jobs', () => {
  const db = setup();
  assert.equal(zaehleOffeneAufgaben(db, '50'), 0);
  db.close();
});

test('zaehleOffeneAufgaben zählt Kontierung und Freigabe 2, nicht den Pool', () => {
  const db = setup();
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '50', stellvertreter2Id: '3' });
  const a = neuerJob(db, 'a.pdf');
  claimJob(db, a, '50');
  const b = neuerJob(db, 'b.pdf');
  setKontierung(db, b, kontoId);
  db.prepare("UPDATE jobs SET status = 'freigabe2' WHERE id = ?").run(b);
  neuerJob(db, 'pool.pdf');
  assert.equal(zaehleOffeneAufgaben(db, '50'), 2);
  db.close();
});

test('loadNavFlags setzt res.locals.navigation nur mit Person', () => {
  const db = setup();
  const config = { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20' } };
  const mw = loadNavFlags(db, config);

  const anon = { path: '/pool', currentPerson: null };
  const resAnon = { locals: {} };
  mw(anon, resAnon, () => {});
  assert.equal(resAnon.locals.navigation, null);

  const person = { churchtools_person_id: '50', gruppen: ['10'] };
  const res = { locals: {} };
  mw({ path: '/pool', currentPerson: person }, res, () => {});
  assert.equal(res.locals.navigation.bereich, 'portal');
  assert.equal(typeof res.locals.navigation.zeigeAdminReiter, 'boolean');
  assert.ok(Array.isArray(res.locals.navigation.gruppen));

  const resAdmin = { locals: {} };
  mw({ path: '/admin/konten', currentPerson: person }, resAdmin, () => {});
  assert.equal(resAdmin.locals.navigation.bereich, 'admin');
  db.close();
});
