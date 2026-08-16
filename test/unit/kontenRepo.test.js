import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import {
  createKonto,
  updateKonto,
  deactivateKonto,
  getKontoById,
  listKonten,
  validateKontoRoles,
  listKontenForPerson,
} from '../../src/db/kontenRepo.js';

function seedPersonen(db) {
  for (const id of ['1', '2', '3', '4', '5']) {
    upsertPerson(db, { id, vorname: `Person${id}`, nachname: 'Muster', email: `p${id}@example.org`, gruppen: ['10'], loggedInNow: false });
  }
}

test('createKonto inserts and getKontoById reads it back', () => {
  const db = openDatabase(':memory:');
  seedPersonen(db);
  const id = createKonto(db, {
    kontonummer: '3000',
    bezeichnung: 'Unterhalt',
    freigeber1Id: '1',
    stellvertreter1Id: '2',
    freigeber2Id: '3',
    stellvertreter2Id: '4',
  });
  const konto = getKontoById(db, id);
  assert.equal(konto.kontonummer, '3000');
  assert.equal(konto.freigeber1_id, '1');
  assert.equal(konto.aktiv, 1);
  db.close();
});

test('updateKonto changes fields in place', () => {
  const db = openDatabase(':memory:');
  seedPersonen(db);
  const id = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  updateKonto(db, id, { kontonummer: '3001', bezeichnung: 'Unterhalt neu', freigeber1Id: '5', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  const konto = getKontoById(db, id);
  assert.equal(konto.kontonummer, '3001');
  assert.equal(konto.freigeber1_id, '5');
  db.close();
});

test('deactivateKonto sets aktiv to 0 without deleting the row', () => {
  const db = openDatabase(':memory:');
  seedPersonen(db);
  const id = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  deactivateKonto(db, id);
  const konto = getKontoById(db, id);
  assert.equal(konto.aktiv, 0);
  db.close();
});

test('getKontoById returns null for an unknown id', () => {
  const db = openDatabase(':memory:');
  assert.equal(getKontoById(db, 999), null);
  db.close();
});

test('listKonten returns only active konten by default, all when includeInactive', () => {
  const db = openDatabase(':memory:');
  seedPersonen(db);
  const activeId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Aktiv', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  const inactiveId = createKonto(db, { kontonummer: '3001', bezeichnung: 'Inaktiv', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  deactivateKonto(db, inactiveId);

  const activeOnly = listKonten(db);
  assert.equal(activeOnly.length, 1);
  assert.equal(activeOnly[0].id, activeId);

  const all = listKonten(db, { includeInactive: true });
  assert.equal(all.length, 2);
  db.close();
});

test('validateKontoRoles rejects missing fields', () => {
  const db = openDatabase(':memory:');
  seedPersonen(db);
  const errors = validateKontoRoles(db, { freigeber1Id: '1', stellvertreter1Id: '', freigeber2Id: '3', stellvertreter2Id: '4' });
  assert.ok(errors.length > 0);
  db.close();
});

test('validateKontoRoles rejects when two roles are the same person', () => {
  const db = openDatabase(':memory:');
  seedPersonen(db);
  const errors = validateKontoRoles(db, { freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '1' });
  assert.ok(errors.some((e) => e.includes('unterschiedliche Personen')));
  db.close();
});

test('validateKontoRoles rejects an inactive person in any role', () => {
  const db = openDatabase(':memory:');
  seedPersonen(db);
  upsertPerson(db, { id: '1', vorname: 'Person1', nachname: 'Muster', email: 'p1@example.org', gruppen: ['10'], loggedInNow: false });
  db.prepare('UPDATE personen SET aktiv = 0 WHERE churchtools_person_id = ?').run('1');
  const errors = validateKontoRoles(db, { freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  assert.ok(errors.some((e) => e.includes('nicht (mehr) aktiv')));
  db.close();
});

test('validateKontoRoles accepts four distinct active persons', () => {
  const db = openDatabase(':memory:');
  seedPersonen(db);
  const errors = validateKontoRoles(db, { freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  assert.deepEqual(errors, []);
  db.close();
});

test('validateKontoRoles rejects a newly assigned person who is no longer resolvable in ChurchTools', async () => {
  const { markUnresolved } = await import('../../src/db/personenRepo.js');
  const db = openDatabase(':memory:');
  seedPersonen(db);
  markUnresolved(db, '4');
  const errors = validateKontoRoles(db, { freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  assert.ok(errors.some((e) => e.includes('nicht mehr auflösbar')));
  db.close();
});

test('validateKontoRoles preserves an already-assigned unresolved person (does not force them out)', async () => {
  const { markUnresolved } = await import('../../src/db/personenRepo.js');
  const db = openDatabase(':memory:');
  seedPersonen(db);
  markUnresolved(db, '4');
  const errors = validateKontoRoles(
    db,
    { freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' },
    { freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' }
  );
  assert.deepEqual(errors, []);
  db.close();
});

test('listKontenForPerson returns only active Konten where the person is freigeber1 or stellvertreter1', () => {
  const db = openDatabase(':memory:');
  for (const id of ['1', '2', '3', '4', '5']) {
    upsertPerson(db, { id, vorname: `Person${id}`, nachname: 'Muster', email: `p${id}@example.org`, gruppen: ['10'], loggedInNow: false });
  }
  const kontoA = createKonto(db, { kontonummer: '3000', bezeichnung: 'A', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  const kontoB = createKonto(db, { kontonummer: '3100', bezeichnung: 'B', freigeber1Id: '5', stellvertreter1Id: '1', freigeber2Id: '3', stellvertreter2Id: '4' });
  const kontoC = createKonto(db, { kontonummer: '3200', bezeichnung: 'C', freigeber1Id: '5', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  deactivateKonto(db, kontoB);

  const rows = listKontenForPerson(db, '1');
  const ids = rows.map((r) => r.id);
  assert.ok(ids.includes(kontoA), 'should include Konto where person is freigeber1');
  assert.ok(!ids.includes(kontoB), 'should exclude an inactive Konto even if person is stellvertreter1');
  assert.ok(!ids.includes(kontoC), 'should exclude a Konto the person has no role on');
  db.close();
});
