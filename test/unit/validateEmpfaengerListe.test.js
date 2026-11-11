import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { validateEmpfaengerListe, empfaengerAnzeige } from '../../src/services/empfaenger.js';

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

test('validateEmpfaengerListe prüft eine 100-kB-Zeile schnell und lehnt sie ab', () => {
  const errors = [];
  const t0 = performance.now();
  validateEmpfaengerListe(`${'a'.repeat(100_000)}@${'b'.repeat(1000)}.`, 'Ziel', errors);
  assert.ok(performance.now() - t0 < 100);
  assert.equal(errors.length, 1);
  assert.ok(errors[0].length < 500);
  const ok = [];
  validateEmpfaengerListe('a@b.ch\r\ngruppe:admin', 'Ziel', ok);
  assert.deepEqual(ok, []);
});

test('empfaengerAnzeige: Gruppen, Personen (inaktiv/unbekannt) und Adressen lesbar', () => {
  const db = db1();
  upsertPerson(db, { id: '2', vorname: 'Ina', nachname: 'Aktiv', email: 'p2@example.org', gruppen: [], loggedInNow: false });
  db.prepare("UPDATE personen SET aktiv = 0 WHERE churchtools_person_id = '2'").run();
  assert.deepEqual(empfaengerAnzeige(db, 'gruppe:buchhaltung\ngruppe:admin\nperson:1\nperson:2\nperson:9\nx@example.org\n'), [
    { art: 'gruppe', label: 'Gruppe Buchhaltung', inaktiv: false, unbekannt: false },
    { art: 'gruppe', label: 'Gruppe Admin', inaktiv: false, unbekannt: false },
    { art: 'person', label: 'A B', inaktiv: false, unbekannt: false },
    { art: 'person', label: 'Ina Aktiv', inaktiv: true, unbekannt: false },
    { art: 'person', label: 'Person 9', inaktiv: false, unbekannt: true },
    { art: 'mail', label: 'x@example.org', inaktiv: false, unbekannt: false },
  ]);
  db.close();
});
