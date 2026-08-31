import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createSpesenabrechnung, getSpesenabrechnungById } from '../../src/db/spesenabrechnungenRepo.js';

test('createSpesenabrechnung inserts a row and returns its id', () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'Ein', nachname: 'Reicher', email: 'e@example.org', gruppen: [] });

  const id = createSpesenabrechnung(db, { eingereichtVon: '1', eingereichtAm: '2026-08-31T08:00:00.000Z', titel: 'Reise Zürich' });

  const row = db.prepare('SELECT * FROM spesenabrechnungen WHERE id = ?').get(id);
  assert.equal(row.eingereicht_von, '1');
  assert.equal(row.titel, 'Reise Zürich');
  db.close();
});

test('createSpesenabrechnung stores a NULL titel when none is given', () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'Ein', nachname: 'Reicher', email: 'e@example.org', gruppen: [] });

  const id = createSpesenabrechnung(db, { eingereichtVon: '1', eingereichtAm: '2026-08-31T08:00:00.000Z', titel: null });

  const row = db.prepare('SELECT * FROM spesenabrechnungen WHERE id = ?').get(id);
  assert.equal(row.titel, null);
  db.close();
});

test('getSpesenabrechnungById returns the row, including its titel', () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'Ein', nachname: 'Reicher', email: 'e@example.org', gruppen: [] });
  const id = createSpesenabrechnung(db, { eingereichtVon: '1', eingereichtAm: '2026-08-31T08:00:00.000Z', titel: 'Reise Zürich' });

  const row = getSpesenabrechnungById(db, id);
  assert.equal(row.id, id);
  assert.equal(row.titel, 'Reise Zürich');
  db.close();
});

test('getSpesenabrechnungById returns null for a nonexistent id or a null id', () => {
  const db = openDatabase(':memory:');
  assert.equal(getSpesenabrechnungById(db, 99999), null);
  assert.equal(getSpesenabrechnungById(db, null), null);
  db.close();
});
