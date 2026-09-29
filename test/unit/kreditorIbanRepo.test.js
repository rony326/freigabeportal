import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { createKreditor } from '../../src/db/kreditorenRepo.js';
import {
  createKreditorIban,
  deleteKreditorIban,
  getKreditorIbanById,
  listKreditorIbansByKreditor,
  listKreditorIbansAll,
  findKreditorIbanByIban,
} from '../../src/db/kreditorIbanRepo.js';

function seedKreditor(db, name = 'Muster AG') {
  return createKreditor(db, { name, kontoId: null });
}

test('createKreditorIban inserts and getKreditorIbanById reads it back', () => {
  const db = openDatabase(':memory:');
  const kreditorId = seedKreditor(db);
  const id = createKreditorIban(db, { kreditorId, iban: 'CH4431999123000889012', quelle: 'manuell' });
  const row = getKreditorIbanById(db, id);
  assert.equal(row.iban, 'CH4431999123000889012');
  assert.equal(row.kreditor_id, kreditorId);
  assert.equal(row.quelle, 'manuell');
  db.close();
});

test('createKreditorIban defaults quelle to manuell when not given', () => {
  const db = openDatabase(':memory:');
  const kreditorId = seedKreditor(db);
  const id = createKreditorIban(db, { kreditorId, iban: 'CH4431999123000889012' });
  assert.equal(getKreditorIbanById(db, id).quelle, 'manuell');
  db.close();
});

test('the iban UNIQUE constraint rejects a duplicate insert, even for a different kreditor', () => {
  const db = openDatabase(':memory:');
  const kreditorA = seedKreditor(db, 'A AG');
  const kreditorB = seedKreditor(db, 'B AG');
  createKreditorIban(db, { kreditorId: kreditorA, iban: 'CH4431999123000889012' });
  assert.throws(() => createKreditorIban(db, { kreditorId: kreditorB, iban: 'CH4431999123000889012' }));
  db.close();
});

test('deleteKreditorIban removes the row', () => {
  const db = openDatabase(':memory:');
  const kreditorId = seedKreditor(db);
  const id = createKreditorIban(db, { kreditorId, iban: 'CH4431999123000889012' });
  deleteKreditorIban(db, id);
  assert.equal(getKreditorIbanById(db, id), null);
  db.close();
});

test('listKreditorIbansByKreditor returns only that kreditor\'s IBANs, sorted', () => {
  const db = openDatabase(':memory:');
  const kreditorA = seedKreditor(db, 'A AG');
  const kreditorB = seedKreditor(db, 'B AG');
  createKreditorIban(db, { kreditorId: kreditorA, iban: 'CH4431999123000889012' });
  createKreditorIban(db, { kreditorId: kreditorA, iban: 'CH1234567890123456789' });
  createKreditorIban(db, { kreditorId: kreditorB, iban: 'CH9999999999999999999' });
  const rows = listKreditorIbansByKreditor(db, kreditorA);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.kreditor_id === kreditorA));
  db.close();
});

test('listKreditorIbansAll returns every mapping', () => {
  const db = openDatabase(':memory:');
  const kreditorId = seedKreditor(db);
  createKreditorIban(db, { kreditorId, iban: 'CH4431999123000889012' });
  createKreditorIban(db, { kreditorId, iban: 'CH1234567890123456789' });
  assert.equal(listKreditorIbansAll(db).length, 2);
  db.close();
});

test('findKreditorIbanByIban finds an existing mapping and returns null otherwise', () => {
  const db = openDatabase(':memory:');
  const kreditorId = seedKreditor(db);
  createKreditorIban(db, { kreditorId, iban: 'CH4431999123000889012' });
  assert.ok(findKreditorIbanByIban(db, 'CH4431999123000889012'));
  assert.equal(findKreditorIbanByIban(db, 'CH0000000000000000000'), null);
  db.close();
});
