import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { createKreditor } from '../../src/db/kreditorenRepo.js';
import {
  createZuweisungsregel,
  updateZuweisungsregel,
  deleteZuweisungsregel,
  getZuweisungsregelById,
  listZuweisungsregeln,
  findZuweisungsregelByMuster,
} from '../../src/db/zuweisungsregelnRepo.js';

function seedKreditor(db) {
  return createKreditor(db, { name: 'Muster AG', kontoId: null });
}

test('createZuweisungsregel inserts and getZuweisungsregelById reads it back', () => {
  const db = openDatabase(':memory:');
  const kreditorId = seedKreditor(db);
  const id = createZuweisungsregel(db, { absenderMuster: 'lieferant.ch', kreditorId });
  const regel = getZuweisungsregelById(db, id);
  assert.equal(regel.absender_muster, 'lieferant.ch');
  assert.equal(regel.kreditor_id, kreditorId);
  db.close();
});

test('updateZuweisungsregel changes fields in place', () => {
  const db = openDatabase(':memory:');
  const kreditorId = seedKreditor(db);
  const id = createZuweisungsregel(db, { absenderMuster: 'lieferant.ch', kreditorId });
  updateZuweisungsregel(db, id, { absenderMuster: 'rechnungen@lieferant.ch', kreditorId });
  assert.equal(getZuweisungsregelById(db, id).absender_muster, 'rechnungen@lieferant.ch');
  db.close();
});

test('deleteZuweisungsregel removes the row', () => {
  const db = openDatabase(':memory:');
  const kreditorId = seedKreditor(db);
  const id = createZuweisungsregel(db, { absenderMuster: 'lieferant.ch', kreditorId });
  deleteZuweisungsregel(db, id);
  assert.equal(getZuweisungsregelById(db, id), null);
  db.close();
});

test('listZuweisungsregeln returns all rules sorted by pattern', () => {
  const db = openDatabase(':memory:');
  const kreditorId = seedKreditor(db);
  createZuweisungsregel(db, { absenderMuster: 'z-lieferant.ch', kreditorId });
  createZuweisungsregel(db, { absenderMuster: 'a-lieferant.ch', kreditorId });
  const rows = listZuweisungsregeln(db);
  assert.deepEqual(rows.map((r) => r.absender_muster), ['a-lieferant.ch', 'z-lieferant.ch']);
  db.close();
});

test('findZuweisungsregelByMuster finds an existing rule and returns null otherwise', () => {
  const db = openDatabase(':memory:');
  const kreditorId = seedKreditor(db);
  createZuweisungsregel(db, { absenderMuster: 'lieferant.ch', kreditorId });
  assert.ok(findZuweisungsregelByMuster(db, 'lieferant.ch'));
  assert.equal(findZuweisungsregelByMuster(db, 'unbekannt.ch'), null);
  db.close();
});

test('the absender_muster UNIQUE constraint rejects a duplicate insert', () => {
  const db = openDatabase(':memory:');
  const kreditorId = seedKreditor(db);
  createZuweisungsregel(db, { absenderMuster: 'lieferant.ch', kreditorId });
  assert.throws(() => createZuweisungsregel(db, { absenderMuster: 'lieferant.ch', kreditorId }));
  db.close();
});
