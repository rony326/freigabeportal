import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { startwerteFuerGruppe } from '../../src/services/berechtigungKatalog.js';
import {
  listGruppenBerechtigungen, listAlleGruppenBerechtigungen, setGruppenBerechtigungen, seedGruppenBerechtigungen,
} from '../../src/db/gruppenBerechtigungenRepo.js';

test('openDatabase seedet die Gruppenrechte gemäss Startwerten', () => {
  const db = openDatabase(':memory:');
  for (const gruppe of ['superadmin', 'manager', 'buchhaltung']) {
    assert.deepEqual(listGruppenBerechtigungen(db, gruppe).sort(), startwerteFuerGruppe(gruppe).sort(), gruppe);
  }
  db.close();
});

test('erneutes Seeding überschreibt geänderte Rechte nicht', () => {
  const db = openDatabase(':memory:');
  setGruppenBerechtigungen(db, 'manager', ['konten_verwalten']);
  seedGruppenBerechtigungen(db);
  assert.deepEqual(listGruppenBerechtigungen(db, 'manager'), ['konten_verwalten']);
  db.close();
});

test('setGruppenBerechtigungen(superadmin, []) lässt gruppenrechte_verwalten stehen', () => {
  const db = openDatabase(':memory:');
  setGruppenBerechtigungen(db, 'superadmin', []);
  assert.deepEqual(listGruppenBerechtigungen(db, 'superadmin'), ['gruppenrechte_verwalten']);
  db.close();
});

test('setGruppenBerechtigungen speichert nur gültige, vergebbare Rechte', () => {
  const db = openDatabase(':memory:');
  setGruppenBerechtigungen(db, 'manager', ['gruppenrechte_verwalten', 'unbekannt', 'konten_verwalten']);
  assert.deepEqual(listGruppenBerechtigungen(db, 'manager'), ['konten_verwalten']);
  db.close();
});

test('unbekannte Gruppe wird abgelehnt', () => {
  const db = openDatabase(':memory:');
  assert.throws(() => setGruppenBerechtigungen(db, 'admin', ['konten_verwalten']), /Gruppe/);
  db.close();
});

test('listAlleGruppenBerechtigungen liefert alle drei Gruppen, auch leere', () => {
  const db = openDatabase(':memory:');
  const alle = listAlleGruppenBerechtigungen(db);
  assert.deepEqual(Object.keys(alle).sort(), ['buchhaltung', 'manager', 'superadmin']);
  assert.deepEqual(alle.buchhaltung, []);
  db.close();
});
