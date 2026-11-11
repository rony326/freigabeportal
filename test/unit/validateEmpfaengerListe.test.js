import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { validateEmpfaengerListe } from '../../src/routes/admin/eskalation.js';

function db1() {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'A', nachname: 'B', email: 'p1@example.org', gruppen: [], loggedInNow: false });
  return db;
}

test('validateEmpfaengerListe accepts person:<id> of an existing person', () => {
  const db = db1();
  const errors = [];
  validateEmpfaengerListe('person:1\ngruppe:admin\nx@example.org', 'L', errors, { db });
  assert.deepEqual(errors, []);
  db.close();
});

test('validateEmpfaengerListe accepts person:<id> of an inactive person', () => {
  const db = db1();
  db.prepare('UPDATE personen SET aktiv = 0').run();
  const errors = [];
  validateEmpfaengerListe('person:1', 'L', errors, { db });
  assert.deepEqual(errors, []);
  db.close();
});

test('validateEmpfaengerListe rejects person:999 as unknown person', () => {
  const db = db1();
  const errors = [];
  validateEmpfaengerListe('person:999', 'L', errors, { db });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /unbekannte Person/);
  db.close();
});

test('validateEmpfaengerListe rejects person: lines with a clear error when no db is passed', () => {
  const errors = [];
  validateEmpfaengerListe('person:1', 'L', errors);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Person/);
});

test('validateEmpfaengerListe: leerErlaubt allows an empty list, default does not', () => {
  const a = [];
  validateEmpfaengerListe('', 'L', a, { leerErlaubt: true });
  assert.deepEqual(a, []);
  const b = [];
  validateEmpfaengerListe('', 'L', b);
  assert.equal(b.length, 1);
});
