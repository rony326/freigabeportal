import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson, deactivatePerson } from '../../src/db/personenRepo.js';
import { setFerienmodus } from '../../src/db/personenRepo.js';
import { getAktivenVertreter, istAktiveVertretungFuer } from '../../src/services/vertretung.js';

function heutePlusTage(tage) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + tage);
  return d.toISOString().slice(0, 10);
}

function seedZweiPersonen(db) {
  upsertPerson(db, { id: '1', vorname: 'Ana', nachname: 'Muster', email: 'ana@example.org', gruppen: ['10'], loggedInNow: true });
  upsertPerson(db, { id: '2', vorname: 'Bo', nachname: 'Muster', email: 'bo@example.org', gruppen: ['10'], loggedInNow: true });
}

test('getAktivenVertreter returns null when no Ferienmodus is set', () => {
  const db = openDatabase(':memory:');
  seedZweiPersonen(db);
  assert.equal(getAktivenVertreter(db, '1'), null);
  db.close();
});

test('getAktivenVertreter returns the stellvertreter when today falls within the period', () => {
  const db = openDatabase(':memory:');
  seedZweiPersonen(db);
  setFerienmodus(db, '1', { von: heutePlusTage(-1), bis: heutePlusTage(1), stellvertreterId: '2' });
  assert.equal(getAktivenVertreter(db, '1'), '2');
  db.close();
});

test('getAktivenVertreter returns null when the period is in the future', () => {
  const db = openDatabase(':memory:');
  seedZweiPersonen(db);
  setFerienmodus(db, '1', { von: heutePlusTage(5), bis: heutePlusTage(10), stellvertreterId: '2' });
  assert.equal(getAktivenVertreter(db, '1'), null);
  db.close();
});

test('getAktivenVertreter returns null when the period is in the past', () => {
  const db = openDatabase(':memory:');
  seedZweiPersonen(db);
  setFerienmodus(db, '1', { von: heutePlusTage(-10), bis: heutePlusTage(-5), stellvertreterId: '2' });
  assert.equal(getAktivenVertreter(db, '1'), null);
  db.close();
});

test('getAktivenVertreter returns null for an unknown person id', () => {
  const db = openDatabase(':memory:');
  assert.equal(getAktivenVertreter(db, 'missing'), null);
  db.close();
});

test('istAktiveVertretungFuer is true only for the currently active stellvertreter', () => {
  const db = openDatabase(':memory:');
  seedZweiPersonen(db);
  setFerienmodus(db, '1', { von: heutePlusTage(-1), bis: heutePlusTage(1), stellvertreterId: '2' });
  assert.equal(istAktiveVertretungFuer(db, '2', '1'), true);
  assert.equal(istAktiveVertretungFuer(db, '1', '1'), false);
  db.close();
});

test('istAktiveVertretungFuer is false when either id is missing/null', () => {
  const db = openDatabase(':memory:');
  seedZweiPersonen(db);
  setFerienmodus(db, '1', { von: heutePlusTage(-1), bis: heutePlusTage(1), stellvertreterId: '2' });
  assert.equal(istAktiveVertretungFuer(db, '2', null), false);
  assert.equal(istAktiveVertretungFuer(db, null, '1'), false);
  db.close();
});

test('getAktivenVertreter returns stellvertreter when today equals von (period starts today)', () => {
  const db = openDatabase(':memory:');
  seedZweiPersonen(db);
  setFerienmodus(db, '1', { von: heutePlusTage(0), bis: heutePlusTage(5), stellvertreterId: '2' });
  assert.equal(getAktivenVertreter(db, '1'), '2');
  db.close();
});

test('getAktivenVertreter returns stellvertreter when today equals bis (period ends today)', () => {
  const db = openDatabase(':memory:');
  seedZweiPersonen(db);
  setFerienmodus(db, '1', { von: heutePlusTage(-5), bis: heutePlusTage(0), stellvertreterId: '2' });
  assert.equal(getAktivenVertreter(db, '1'), '2');
  db.close();
});

test('getAktivenVertreter returns null when period starts tomorrow (von = tomorrow)', () => {
  const db = openDatabase(':memory:');
  seedZweiPersonen(db);
  setFerienmodus(db, '1', { von: heutePlusTage(1), bis: heutePlusTage(1), stellvertreterId: '2' });
  assert.equal(getAktivenVertreter(db, '1'), null);
  db.close();
});

test('getAktivenVertreter returns null when period ended yesterday (bis = yesterday)', () => {
  const db = openDatabase(':memory:');
  seedZweiPersonen(db);
  setFerienmodus(db, '1', { von: heutePlusTage(-5), bis: heutePlusTage(-1), stellvertreterId: '2' });
  assert.equal(getAktivenVertreter(db, '1'), null);
  db.close();
});

test('getAktivenVertreter returns null when the chosen Stellvertreter has since been deactivated, even though the date window is still open', () => {
  const db = openDatabase(':memory:');
  seedZweiPersonen(db);
  setFerienmodus(db, '1', { von: heutePlusTage(-1), bis: heutePlusTage(1), stellvertreterId: '2' });
  deactivatePerson(db, '2');
  assert.equal(getAktivenVertreter(db, '1'), null);
  db.close();
});

test('istAktiveVertretungFuer is false once the candidate Stellvertreter has been deactivated', () => {
  const db = openDatabase(':memory:');
  seedZweiPersonen(db);
  setFerienmodus(db, '1', { von: heutePlusTage(-1), bis: heutePlusTage(1), stellvertreterId: '2' });
  deactivatePerson(db, '2');
  assert.equal(istAktiveVertretungFuer(db, '2', '1'), false);
  db.close();
});

test('getAktivenVertreter is unaffected by the ABSENT person\'s own aktiv flag (only the Stellvertreter\'s aktiv status is checked here)', () => {
  const db = openDatabase(':memory:');
  seedZweiPersonen(db);
  setFerienmodus(db, '1', { von: heutePlusTage(-1), bis: heutePlusTage(1), stellvertreterId: '2' });
  deactivatePerson(db, '1');
  assert.equal(getAktivenVertreter(db, '1'), '2');
  db.close();
});
