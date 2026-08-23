import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import {
  listBerechtigungenForPerson,
  setBerechtigungenForPerson,
  personHasBerechtigung,
} from '../../src/db/personBerechtigungenRepo.js';

function seedPerson(db, id) {
  upsertPerson(db, { id, vorname: 'Test', nachname: 'Person', email: `${id}@example.org`, gruppen: [], loggedInNow: false });
}

test('listBerechtigungenForPerson returns an empty array for a person with none', () => {
  const db = openDatabase(':memory:');
  seedPerson(db, '1');
  assert.deepEqual(listBerechtigungenForPerson(db, '1'), []);
  db.close();
});

test('setBerechtigungenForPerson inserts the given set and listBerechtigungenForPerson reflects it', () => {
  const db = openDatabase(':memory:');
  seedPerson(db, '1');
  setBerechtigungenForPerson(db, '1', ['konten_verwalten', 'mails_einsehen']);
  assert.deepEqual(listBerechtigungenForPerson(db, '1').sort(), ['konten_verwalten', 'mails_einsehen']);
  db.close();
});

test('setBerechtigungenForPerson replaces the previous set entirely (removes what is no longer included)', () => {
  const db = openDatabase(':memory:');
  seedPerson(db, '1');
  setBerechtigungenForPerson(db, '1', ['konten_verwalten', 'mails_einsehen']);
  setBerechtigungenForPerson(db, '1', ['sync_einsehen']);
  assert.deepEqual(listBerechtigungenForPerson(db, '1'), ['sync_einsehen']);
  db.close();
});

test('setBerechtigungenForPerson with an empty array clears all rights', () => {
  const db = openDatabase(':memory:');
  seedPerson(db, '1');
  setBerechtigungenForPerson(db, '1', ['konten_verwalten']);
  setBerechtigungenForPerson(db, '1', []);
  assert.deepEqual(listBerechtigungenForPerson(db, '1'), []);
  db.close();
});

test('setBerechtigungenForPerson does not affect another person\'s rights', () => {
  const db = openDatabase(':memory:');
  seedPerson(db, '1');
  seedPerson(db, '2');
  setBerechtigungenForPerson(db, '1', ['konten_verwalten']);
  setBerechtigungenForPerson(db, '2', ['sync_einsehen']);
  assert.deepEqual(listBerechtigungenForPerson(db, '1'), ['konten_verwalten']);
  assert.deepEqual(listBerechtigungenForPerson(db, '2'), ['sync_einsehen']);
  db.close();
});

test('personHasBerechtigung returns true only for a granted right', () => {
  const db = openDatabase(':memory:');
  seedPerson(db, '1');
  setBerechtigungenForPerson(db, '1', ['debitoren_verwalten']);
  assert.equal(personHasBerechtigung(db, '1', 'debitoren_verwalten'), true);
  assert.equal(personHasBerechtigung(db, '1', 'konten_verwalten'), false);
  db.close();
});

test('personHasBerechtigung returns false for a person with no rows at all', () => {
  const db = openDatabase(':memory:');
  seedPerson(db, '1');
  assert.equal(personHasBerechtigung(db, '1', 'konten_verwalten'), false);
  db.close();
});

test('inserting a berechtigung outside the catalog violates the CHECK constraint', () => {
  const db = openDatabase(':memory:');
  seedPerson(db, '1');
  assert.throws(() => {
    db.prepare('INSERT INTO person_berechtigungen (person_id, berechtigung) VALUES (?, ?)').run('1', 'basis_einstellungen');
  });
  db.close();
});
