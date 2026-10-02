import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createKonto } from '../../src/db/kontenRepo.js';
import { createKreditor, updateKreditor, deactivateKreditor, getKreditorById, listKreditoren } from '../../src/db/kreditorenRepo.js';

function seedKonto(db) {
  for (const id of ['1', '2', '3', '4']) {
    upsertPerson(db, { id, vorname: `Person${id}`, nachname: 'Muster', email: `p${id}@example.org`, gruppen: ['10'], loggedInNow: false });
  }
  return createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
}

test('createKreditor inserts with an optional Konto, getKreditorById reads it back active by default', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const id = createKreditor(db, { name: 'Muster AG', kontoId });
  const kreditor = getKreditorById(db, id);
  assert.equal(kreditor.name, 'Muster AG');
  assert.equal(kreditor.konto_id, kontoId);
  assert.equal(kreditor.aktiv, 1);
  db.close();
});

test('createKreditor without a Konto stores null', () => {
  const db = openDatabase(':memory:');
  const id = createKreditor(db, { name: 'Muster AG', kontoId: null });
  assert.equal(getKreditorById(db, id).konto_id, null);
  db.close();
});

test('updateKreditor changes name and Konto in place', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const id = createKreditor(db, { name: 'Alt AG', kontoId: null });
  updateKreditor(db, id, { name: 'Neu AG', kontoId });
  const kreditor = getKreditorById(db, id);
  assert.equal(kreditor.name, 'Neu AG');
  assert.equal(kreditor.konto_id, kontoId);
  db.close();
});

test('deactivateKreditor sets aktiv to 0', () => {
  const db = openDatabase(':memory:');
  const id = createKreditor(db, { name: 'Muster AG', kontoId: null });
  deactivateKreditor(db, id);
  assert.equal(getKreditorById(db, id).aktiv, 0);
  db.close();
});

test('listKreditoren returns only active Kreditoren by default, sorted by name; includeInactive returns all', () => {
  const db = openDatabase(':memory:');
  const idA = createKreditor(db, { name: 'B AG', kontoId: null });
  const idB = createKreditor(db, { name: 'A AG', kontoId: null });
  deactivateKreditor(db, idA);

  const aktive = listKreditoren(db);
  assert.equal(aktive.length, 1);
  assert.equal(aktive[0].id, idB);

  const alle = listKreditoren(db, { includeInactive: true });
  assert.deepEqual(alle.map((d) => d.name), ['A AG', 'B AG']);
  db.close();
});
