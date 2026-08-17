import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createKonto } from '../../src/db/kontenRepo.js';
import { createDebitor, updateDebitor, deactivateDebitor, getDebitorById, listDebitoren } from '../../src/db/debitorenRepo.js';

function seedKonto(db) {
  for (const id of ['1', '2', '3', '4']) {
    upsertPerson(db, { id, vorname: `Person${id}`, nachname: 'Muster', email: `p${id}@example.org`, gruppen: ['10'], loggedInNow: false });
  }
  return createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
}

test('createDebitor inserts with an optional Konto, getDebitorById reads it back active by default', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const id = createDebitor(db, { name: 'Muster AG', kontoId });
  const debitor = getDebitorById(db, id);
  assert.equal(debitor.name, 'Muster AG');
  assert.equal(debitor.konto_id, kontoId);
  assert.equal(debitor.aktiv, 1);
  db.close();
});

test('createDebitor without a Konto stores null', () => {
  const db = openDatabase(':memory:');
  const id = createDebitor(db, { name: 'Muster AG', kontoId: null });
  assert.equal(getDebitorById(db, id).konto_id, null);
  db.close();
});

test('updateDebitor changes name and Konto in place', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const id = createDebitor(db, { name: 'Alt AG', kontoId: null });
  updateDebitor(db, id, { name: 'Neu AG', kontoId });
  const debitor = getDebitorById(db, id);
  assert.equal(debitor.name, 'Neu AG');
  assert.equal(debitor.konto_id, kontoId);
  db.close();
});

test('deactivateDebitor sets aktiv to 0', () => {
  const db = openDatabase(':memory:');
  const id = createDebitor(db, { name: 'Muster AG', kontoId: null });
  deactivateDebitor(db, id);
  assert.equal(getDebitorById(db, id).aktiv, 0);
  db.close();
});

test('listDebitoren returns only active Debitoren by default, sorted by name; includeInactive returns all', () => {
  const db = openDatabase(':memory:');
  const idA = createDebitor(db, { name: 'B AG', kontoId: null });
  const idB = createDebitor(db, { name: 'A AG', kontoId: null });
  deactivateDebitor(db, idA);

  const aktive = listDebitoren(db);
  assert.equal(aktive.length, 1);
  assert.equal(aktive[0].id, idB);

  const alle = listDebitoren(db, { includeInactive: true });
  assert.deepEqual(alle.map((d) => d.name), ['A AG', 'B AG']);
  db.close();
});
