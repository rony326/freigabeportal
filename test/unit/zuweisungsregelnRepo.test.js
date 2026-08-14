import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createKonto } from '../../src/db/kontenRepo.js';
import {
  createZuweisungsregel,
  updateZuweisungsregel,
  deleteZuweisungsregel,
  getZuweisungsregelById,
  listZuweisungsregeln,
  findZuweisungsregelByMuster,
} from '../../src/db/zuweisungsregelnRepo.js';

function seedKonto(db) {
  for (const id of ['1', '2', '3', '4']) {
    upsertPerson(db, { id, vorname: `Person${id}`, nachname: 'Muster', email: `p${id}@example.org`, gruppen: ['10'], loggedInNow: false });
  }
  return createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
}

test('createZuweisungsregel inserts and getZuweisungsregelById reads it back', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const id = createZuweisungsregel(db, { absenderMuster: 'lieferant.ch', kontoId });
  const regel = getZuweisungsregelById(db, id);
  assert.equal(regel.absender_muster, 'lieferant.ch');
  assert.equal(regel.konto_id, kontoId);
  db.close();
});

test('updateZuweisungsregel changes fields in place', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const id = createZuweisungsregel(db, { absenderMuster: 'lieferant.ch', kontoId });
  updateZuweisungsregel(db, id, { absenderMuster: 'rechnungen@lieferant.ch', kontoId });
  assert.equal(getZuweisungsregelById(db, id).absender_muster, 'rechnungen@lieferant.ch');
  db.close();
});

test('deleteZuweisungsregel removes the row', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const id = createZuweisungsregel(db, { absenderMuster: 'lieferant.ch', kontoId });
  deleteZuweisungsregel(db, id);
  assert.equal(getZuweisungsregelById(db, id), null);
  db.close();
});

test('listZuweisungsregeln returns all rules sorted by pattern', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  createZuweisungsregel(db, { absenderMuster: 'z-lieferant.ch', kontoId });
  createZuweisungsregel(db, { absenderMuster: 'a-lieferant.ch', kontoId });
  const rows = listZuweisungsregeln(db);
  assert.deepEqual(rows.map((r) => r.absender_muster), ['a-lieferant.ch', 'z-lieferant.ch']);
  db.close();
});

test('findZuweisungsregelByMuster finds an existing rule and returns null otherwise', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  createZuweisungsregel(db, { absenderMuster: 'lieferant.ch', kontoId });
  assert.ok(findZuweisungsregelByMuster(db, 'lieferant.ch'));
  assert.equal(findZuweisungsregelByMuster(db, 'unbekannt.ch'), null);
  db.close();
});

test('the absender_muster UNIQUE constraint rejects a duplicate insert', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  createZuweisungsregel(db, { absenderMuster: 'lieferant.ch', kontoId });
  assert.throws(() => createZuweisungsregel(db, { absenderMuster: 'lieferant.ch', kontoId }));
  db.close();
});
