import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { createDebitor } from '../../src/db/debitorenRepo.js';
import {
  createZuweisungsregel,
  updateZuweisungsregel,
  deleteZuweisungsregel,
  getZuweisungsregelById,
  listZuweisungsregeln,
  findZuweisungsregelByMuster,
} from '../../src/db/zuweisungsregelnRepo.js';

function seedDebitor(db) {
  return createDebitor(db, { name: 'Muster AG', kontoId: null });
}

test('createZuweisungsregel inserts and getZuweisungsregelById reads it back', () => {
  const db = openDatabase(':memory:');
  const debitorId = seedDebitor(db);
  const id = createZuweisungsregel(db, { absenderMuster: 'lieferant.ch', debitorId });
  const regel = getZuweisungsregelById(db, id);
  assert.equal(regel.absender_muster, 'lieferant.ch');
  assert.equal(regel.debitor_id, debitorId);
  db.close();
});

test('updateZuweisungsregel changes fields in place', () => {
  const db = openDatabase(':memory:');
  const debitorId = seedDebitor(db);
  const id = createZuweisungsregel(db, { absenderMuster: 'lieferant.ch', debitorId });
  updateZuweisungsregel(db, id, { absenderMuster: 'rechnungen@lieferant.ch', debitorId });
  assert.equal(getZuweisungsregelById(db, id).absender_muster, 'rechnungen@lieferant.ch');
  db.close();
});

test('deleteZuweisungsregel removes the row', () => {
  const db = openDatabase(':memory:');
  const debitorId = seedDebitor(db);
  const id = createZuweisungsregel(db, { absenderMuster: 'lieferant.ch', debitorId });
  deleteZuweisungsregel(db, id);
  assert.equal(getZuweisungsregelById(db, id), null);
  db.close();
});

test('listZuweisungsregeln returns all rules sorted by pattern', () => {
  const db = openDatabase(':memory:');
  const debitorId = seedDebitor(db);
  createZuweisungsregel(db, { absenderMuster: 'z-lieferant.ch', debitorId });
  createZuweisungsregel(db, { absenderMuster: 'a-lieferant.ch', debitorId });
  const rows = listZuweisungsregeln(db);
  assert.deepEqual(rows.map((r) => r.absender_muster), ['a-lieferant.ch', 'z-lieferant.ch']);
  db.close();
});

test('findZuweisungsregelByMuster finds an existing rule and returns null otherwise', () => {
  const db = openDatabase(':memory:');
  const debitorId = seedDebitor(db);
  createZuweisungsregel(db, { absenderMuster: 'lieferant.ch', debitorId });
  assert.ok(findZuweisungsregelByMuster(db, 'lieferant.ch'));
  assert.equal(findZuweisungsregelByMuster(db, 'unbekannt.ch'), null);
  db.close();
});

test('the absender_muster UNIQUE constraint rejects a duplicate insert', () => {
  const db = openDatabase(':memory:');
  const debitorId = seedDebitor(db);
  createZuweisungsregel(db, { absenderMuster: 'lieferant.ch', debitorId });
  assert.throws(() => createZuweisungsregel(db, { absenderMuster: 'lieferant.ch', debitorId }));
  db.close();
});
