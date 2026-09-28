import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createKreditkarte, setKreditkarteAktiv } from '../../src/db/kreditkartenRepo.js';
import { erkenneKarte } from '../../src/services/kkErkennung.js';

function setup() {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'A', nachname: 'B', email: 'a@example.org', gruppen: [] });
  const visa = createKreditkarte(db, { bezeichnung: 'Visa', karteEndziffern: '4242', verantwortlichId: '1', erfassungOffen: true, absenderMuster: 'viseca.ch' });
  const master = createKreditkarte(db, { bezeichnung: 'Master', karteEndziffern: '1111', verantwortlichId: '1', erfassungOffen: true, absenderMuster: 'abrechnung@bank.example' });
  return { db, visa, master };
}

test('erkenneKarte by sender domain, by exact sender, and by card digits', () => {
  const { db, visa, master } = setup();
  assert.equal(erkenneKarte(db, { absender: 'Viseca <noreply@mail.viseca.ch>', text: '' }).karte.id, visa);
  assert.equal(erkenneKarte(db, { absender: 'abrechnung@bank.example', text: '' }).karte.id, master);
  assert.equal(erkenneKarte(db, { absender: null, text: 'Karte **** 1111' }).karte.id, master);
  db.close();
});

test('erkenneKarte returns null when nothing or more than one card matches, and ignores inactive cards', () => {
  const { db, visa } = setup();
  assert.equal(erkenneKarte(db, { absender: 'x@y.example', text: 'nichts' }), null);
  assert.equal(erkenneKarte(db, { absender: 'noreply@viseca.ch', text: 'Karte **** 1111' }), null);
  setKreditkarteAktiv(db, visa, false);
  assert.equal(erkenneKarte(db, { absender: 'noreply@viseca.ch', text: '' }), null);
  db.close();
});
