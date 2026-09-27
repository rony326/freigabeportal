import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import {
  createKreditkarte, updateKreditkarte, setKreditkarteAktiv, getKreditkarteById,
  listKreditkarten, listErfasserIds, setErfasser,
} from '../../src/db/kreditkartenRepo.js';

function setup() {
  const db = openDatabase(':memory:');
  for (const id of ['1', '2', '3']) upsertPerson(db, { id, vorname: `P${id}`, nachname: 'M', email: `p${id}@example.org`, gruppen: [] });
  return db;
}

test('createKreditkarte stores all fields and getKreditkarteById returns them', () => {
  const db = setup();
  const id = createKreditkarte(db, { bezeichnung: 'Visa Jugend', karteEndziffern: '4242', karteninhaberName: 'Anna M', verantwortlichId: '1', erfassungOffen: true, absenderMuster: null });
  const karte = getKreditkarteById(db, id);
  assert.equal(karte.bezeichnung, 'Visa Jugend');
  assert.equal(karte.karte_endziffern, '4242');
  assert.equal(karte.verantwortlich_id, '1');
  assert.equal(karte.erfassung_offen, 1);
  assert.equal(karte.aktiv, 1);
  db.close();
});

test('listKreditkarten hides inactive cards unless includeInactive', () => {
  const db = setup();
  const a = createKreditkarte(db, { bezeichnung: 'A', verantwortlichId: '1', erfassungOffen: true });
  createKreditkarte(db, { bezeichnung: 'B', verantwortlichId: '1', erfassungOffen: true });
  setKreditkarteAktiv(db, a, false);
  assert.deepEqual(listKreditkarten(db).map((k) => k.bezeichnung), ['B']);
  assert.deepEqual(listKreditkarten(db, { includeInactive: true }).map((k) => k.bezeichnung), ['A', 'B']);
  db.close();
});

test('updateKreditkarte changes fields, setErfasser replaces the list', () => {
  const db = setup();
  const id = createKreditkarte(db, { bezeichnung: 'A', verantwortlichId: '1', erfassungOffen: true });
  updateKreditkarte(db, id, { bezeichnung: 'A2', karteEndziffern: null, karteninhaberName: null, verantwortlichId: '2', erfassungOffen: false, absenderMuster: null });
  assert.equal(getKreditkarteById(db, id).verantwortlich_id, '2');
  assert.equal(getKreditkarteById(db, id).erfassung_offen, 0);
  setErfasser(db, id, ['1', '3']);
  assert.deepEqual(listErfasserIds(db, id).sort(), ['1', '3']);
  setErfasser(db, id, ['2']);
  assert.deepEqual(listErfasserIds(db, id), ['2']);
  db.close();
});
