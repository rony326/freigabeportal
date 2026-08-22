import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { createDebitor } from '../../src/db/debitorenRepo.js';
import {
  createDebitorIban,
  deleteDebitorIban,
  getDebitorIbanById,
  listDebitorIbansByDebitor,
  listDebitorIbansAll,
  findDebitorIbanByIban,
} from '../../src/db/debitorIbanRepo.js';

function seedDebitor(db, name = 'Muster AG') {
  return createDebitor(db, { name, kontoId: null });
}

test('createDebitorIban inserts and getDebitorIbanById reads it back', () => {
  const db = openDatabase(':memory:');
  const debitorId = seedDebitor(db);
  const id = createDebitorIban(db, { debitorId, iban: 'CH4431999123000889012', quelle: 'manuell' });
  const row = getDebitorIbanById(db, id);
  assert.equal(row.iban, 'CH4431999123000889012');
  assert.equal(row.debitor_id, debitorId);
  assert.equal(row.quelle, 'manuell');
  db.close();
});

test('createDebitorIban defaults quelle to manuell when not given', () => {
  const db = openDatabase(':memory:');
  const debitorId = seedDebitor(db);
  const id = createDebitorIban(db, { debitorId, iban: 'CH4431999123000889012' });
  assert.equal(getDebitorIbanById(db, id).quelle, 'manuell');
  db.close();
});

test('the iban UNIQUE constraint rejects a duplicate insert, even for a different debitor', () => {
  const db = openDatabase(':memory:');
  const debitorA = seedDebitor(db, 'A AG');
  const debitorB = seedDebitor(db, 'B AG');
  createDebitorIban(db, { debitorId: debitorA, iban: 'CH4431999123000889012' });
  assert.throws(() => createDebitorIban(db, { debitorId: debitorB, iban: 'CH4431999123000889012' }));
  db.close();
});

test('deleteDebitorIban removes the row', () => {
  const db = openDatabase(':memory:');
  const debitorId = seedDebitor(db);
  const id = createDebitorIban(db, { debitorId, iban: 'CH4431999123000889012' });
  deleteDebitorIban(db, id);
  assert.equal(getDebitorIbanById(db, id), null);
  db.close();
});

test('listDebitorIbansByDebitor returns only that debitor\'s IBANs, sorted', () => {
  const db = openDatabase(':memory:');
  const debitorA = seedDebitor(db, 'A AG');
  const debitorB = seedDebitor(db, 'B AG');
  createDebitorIban(db, { debitorId: debitorA, iban: 'CH4431999123000889012' });
  createDebitorIban(db, { debitorId: debitorA, iban: 'CH1234567890123456789' });
  createDebitorIban(db, { debitorId: debitorB, iban: 'CH9999999999999999999' });
  const rows = listDebitorIbansByDebitor(db, debitorA);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.debitor_id === debitorA));
  db.close();
});

test('listDebitorIbansAll returns every mapping', () => {
  const db = openDatabase(':memory:');
  const debitorId = seedDebitor(db);
  createDebitorIban(db, { debitorId, iban: 'CH4431999123000889012' });
  createDebitorIban(db, { debitorId, iban: 'CH1234567890123456789' });
  assert.equal(listDebitorIbansAll(db).length, 2);
  db.close();
});

test('findDebitorIbanByIban finds an existing mapping and returns null otherwise', () => {
  const db = openDatabase(':memory:');
  const debitorId = seedDebitor(db);
  createDebitorIban(db, { debitorId, iban: 'CH4431999123000889012' });
  assert.ok(findDebitorIbanByIban(db, 'CH4431999123000889012'));
  assert.equal(findDebitorIbanByIban(db, 'CH0000000000000000000'), null);
  db.close();
});
