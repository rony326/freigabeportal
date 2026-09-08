import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson, getPersonById, deactivatePerson, listActivePersonsInGroup, listAllPersons, setFerienmodus, clearFerienmodus } from '../../src/db/personenRepo.js';

test('upsertPerson inserts a new person', () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'Ana', nachname: 'Muster', email: 'ana@example.org', gruppen: ['10'], loggedInNow: true });
  const person = getPersonById(db, '1');
  assert.equal(person.vorname, 'Ana');
  assert.deepEqual(person.gruppen, ['10']);
  assert.equal(person.aktiv, true);
  assert.ok(person.last_login_at);
  db.close();
});

test('listAllPersons parses gruppen back into an array for every row', () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'Ana', nachname: 'Muster', email: 'ana@example.org', gruppen: ['10', '20'], loggedInNow: true });
  upsertPerson(db, { id: '2', vorname: 'Bo', nachname: 'Muster', email: 'bo@example.org', gruppen: [], loggedInNow: true });
  const persons = listAllPersons(db);
  assert.deepEqual(persons.find((p) => p.churchtools_person_id === '1').gruppen, ['10', '20']);
  assert.deepEqual(persons.find((p) => p.churchtools_person_id === '2').gruppen, []);
  db.close();
});

test('upsertPerson keeps last_login_at when a background sync runs (loggedInNow: false)', () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'Ana', nachname: 'Muster', email: 'ana@example.org', gruppen: ['10'], loggedInNow: true });
  const afterLogin = getPersonById(db, '1');

  upsertPerson(db, { id: '1', vorname: 'Ana Maria', nachname: 'Muster', email: 'ana@example.org', gruppen: ['10', '20'], loggedInNow: false });
  const afterSync = getPersonById(db, '1');

  assert.equal(afterSync.last_login_at, afterLogin.last_login_at);
  assert.equal(afterSync.vorname, 'Ana Maria');
  assert.deepEqual(afterSync.gruppen, ['10', '20']);
  db.close();
});

test('getPersonById returns null for an unknown id', () => {
  const db = openDatabase(':memory:');
  assert.equal(getPersonById(db, 'missing'), null);
  db.close();
});

test('upsertPerson clears a stale ct_person_unresolved flag once the person resolves again', () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'Ana', nachname: 'Muster', email: 'ana@example.org', gruppen: ['10'], loggedInNow: false });
  db.prepare('UPDATE personen SET ct_person_unresolved = 1 WHERE churchtools_person_id = ?').run('1');
  assert.equal(getPersonById(db, '1').ct_person_unresolved, true);

  upsertPerson(db, { id: '1', vorname: 'Ana', nachname: 'Muster', email: 'ana@example.org', gruppen: ['10'], loggedInNow: false });

  assert.equal(getPersonById(db, '1').ct_person_unresolved, false);
  db.close();
});

test('listActivePersonsInGroup returns only active persons who belong to the given group', () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'In', nachname: 'Gruppe', email: 'in@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '2', vorname: 'Nicht', nachname: 'Gruppe', email: 'nicht@example.org', gruppen: ['20'], loggedInNow: false });
  upsertPerson(db, { id: '3', vorname: 'Auch', nachname: 'Gruppe', email: 'auch@example.org', gruppen: ['10', '20'], loggedInNow: false });
  deactivatePerson(db, '3');

  const result = listActivePersonsInGroup(db, '10');
  assert.equal(result.length, 1);
  assert.equal(result[0].email, 'in@example.org');
  db.close();
});

test('setFerienmodus stores the vacation period and stellvertreter on the person row', () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'Ana', nachname: 'Muster', email: 'ana@example.org', gruppen: ['10'], loggedInNow: true });
  upsertPerson(db, { id: '2', vorname: 'Bo', nachname: 'Muster', email: 'bo@example.org', gruppen: ['10'], loggedInNow: true });

  setFerienmodus(db, '1', { von: '2026-09-10', bis: '2026-09-24', stellvertreterId: '2' });

  const person = getPersonById(db, '1');
  assert.equal(person.ferienmodus_von, '2026-09-10');
  assert.equal(person.ferienmodus_bis, '2026-09-24');
  assert.equal(person.ferienmodus_stellvertreter_id, '2');
  db.close();
});

test('setFerienmodus overwrites a previously set period', () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'Ana', nachname: 'Muster', email: 'ana@example.org', gruppen: ['10'], loggedInNow: true });
  upsertPerson(db, { id: '2', vorname: 'Bo', nachname: 'Muster', email: 'bo@example.org', gruppen: ['10'], loggedInNow: true });
  upsertPerson(db, { id: '3', vorname: 'Cé', nachname: 'Muster', email: 'ce@example.org', gruppen: ['10'], loggedInNow: true });

  setFerienmodus(db, '1', { von: '2026-09-10', bis: '2026-09-24', stellvertreterId: '2' });
  setFerienmodus(db, '1', { von: '2026-10-01', bis: '2026-10-05', stellvertreterId: '3' });

  const person = getPersonById(db, '1');
  assert.equal(person.ferienmodus_von, '2026-10-01');
  assert.equal(person.ferienmodus_stellvertreter_id, '3');
  db.close();
});

test('clearFerienmodus resets all three fields to null', () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'Ana', nachname: 'Muster', email: 'ana@example.org', gruppen: ['10'], loggedInNow: true });
  upsertPerson(db, { id: '2', vorname: 'Bo', nachname: 'Muster', email: 'bo@example.org', gruppen: ['10'], loggedInNow: true });
  setFerienmodus(db, '1', { von: '2026-09-10', bis: '2026-09-24', stellvertreterId: '2' });

  clearFerienmodus(db, '1');

  const person = getPersonById(db, '1');
  assert.equal(person.ferienmodus_von, null);
  assert.equal(person.ferienmodus_bis, null);
  assert.equal(person.ferienmodus_stellvertreter_id, null);
  db.close();
});
