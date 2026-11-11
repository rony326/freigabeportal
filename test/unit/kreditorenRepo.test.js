import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createKonto } from '../../src/db/kontenRepo.js';
import { createKreditor, updateKreditor, deactivateKreditor, getKreditorById, listKreditoren } from '../../src/db/kreditorenRepo.js';

function seedKonto(db) {
  for (const id of ['1', '2', '3', '4']) {
    upsertPerson(db, { id, vorname: `Person${id}`, nachname: 'Muster', email: `p${id}@example.org`, gruppen: ['10'], loggedInNow: false });
  }
  return createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
}

test('createKreditor inserts with an optional Konto, getKreditorById reads it back active by default', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const id = createKreditor(db, { name: 'Muster AG', kontoId });
  const kreditor = getKreditorById(db, id);
  assert.equal(kreditor.name, 'Muster AG');
  assert.equal(kreditor.konto_id, kontoId);
  assert.equal(kreditor.aktiv, 1);
  db.close();
});

test('createKreditor without a Konto stores null', () => {
  const db = openDatabase(':memory:');
  const id = createKreditor(db, { name: 'Muster AG', kontoId: null });
  assert.equal(getKreditorById(db, id).konto_id, null);
  db.close();
});

test('updateKreditor changes name and Konto in place', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const id = createKreditor(db, { name: 'Alt AG', kontoId: null });
  updateKreditor(db, id, { name: 'Neu AG', kontoId });
  const kreditor = getKreditorById(db, id);
  assert.equal(kreditor.name, 'Neu AG');
  assert.equal(kreditor.konto_id, kontoId);
  db.close();
});

test('deactivateKreditor sets aktiv to 0', () => {
  const db = openDatabase(':memory:');
  const id = createKreditor(db, { name: 'Muster AG', kontoId: null });
  deactivateKreditor(db, id);
  assert.equal(getKreditorById(db, id).aktiv, 0);
  db.close();
});

test('listKreditoren returns only active Kreditoren by default, sorted by name; includeInactive returns all', () => {
  const db = openDatabase(':memory:');
  const idA = createKreditor(db, { name: 'B AG', kontoId: null });
  const idB = createKreditor(db, { name: 'A AG', kontoId: null });
  deactivateKreditor(db, idA);

  const aktive = listKreditoren(db);
  assert.equal(aktive.length, 1);
  assert.equal(aktive[0].id, idB);

  const alle = listKreditoren(db, { includeInactive: true });
  assert.deepEqual(alle.map((d) => d.name), ['A AG', 'B AG']);
  db.close();
});

// --- Zahlungsart, Beträge schwanken, Vollständigkeit ---
import {
  ZAHLUNGSARTEN, ZAHLUNGSART_LABEL, brauchtIban, istKreditorVollstaendig, listKreditorenWaehlbar,
} from '../../src/db/kreditorenRepo.js';
import { createKreditorIban } from '../../src/db/kreditorIbanRepo.js';
import { kreditorMitIban, kreditorOhneIbanPflicht } from '../helpers/kreditor.js';

test('Zahlungsart defaults to ueberweisung, betrag_schwankt to 0', () => {
  const db = openDatabase(':memory:');
  const k = getKreditorById(db, createKreditor(db, { name: 'A AG' }));
  assert.equal(k.zahlungsart, 'ueberweisung');
  assert.equal(k.betrag_schwankt, 0);
  db.close();
});

test('constants list the four Zahlungsarten with labels', () => {
  assert.deepEqual(ZAHLUNGSARTEN, ['ueberweisung', 'dauerauftrag', 'lastschrift', 'kreditkarte']);
  assert.equal(ZAHLUNGSART_LABEL.ueberweisung, 'Überweisung');
  assert.equal(brauchtIban('ueberweisung'), true);
  assert.equal(brauchtIban('dauerauftrag'), true);
  assert.equal(brauchtIban('lastschrift'), false);
  assert.equal(brauchtIban('kreditkarte'), false);
});

test('createKreditor stores zahlungsart and betragSchwankt, rejects invalid zahlungsart', () => {
  const db = openDatabase(':memory:');
  const k = getKreditorById(db, createKreditor(db, { name: 'B AG', zahlungsart: 'lastschrift', betragSchwankt: true }));
  assert.equal(k.zahlungsart, 'lastschrift');
  assert.equal(k.betrag_schwankt, 1);
  assert.throws(() => createKreditor(db, { name: 'C AG', zahlungsart: 'bitcoin' }), /Zahlungsart/);
  db.close();
});

test('updateKreditor changes zahlungsart/betragSchwankt, leaves them untouched when omitted, rejects invalid', () => {
  const db = openDatabase(':memory:');
  const id = createKreditor(db, { name: 'D AG', zahlungsart: 'dauerauftrag', betragSchwankt: true });
  updateKreditor(db, id, { name: 'D2 AG', kontoId: null });
  let k = getKreditorById(db, id);
  assert.equal(k.name, 'D2 AG');
  assert.equal(k.zahlungsart, 'dauerauftrag');
  assert.equal(k.betrag_schwankt, 1);
  updateKreditor(db, id, { name: 'D2 AG', kontoId: null, zahlungsart: 'kreditkarte', betragSchwankt: false });
  k = getKreditorById(db, id);
  assert.equal(k.zahlungsart, 'kreditkarte');
  assert.equal(k.betrag_schwankt, 0);
  assert.throws(() => updateKreditor(db, id, { name: 'x', kontoId: null, zahlungsart: 'nix' }), /Zahlungsart/);
  db.close();
});

test('istKreditorVollstaendig: needs an IBAN only for ueberweisung/dauerauftrag', () => {
  const db = openDatabase(':memory:');
  const ohne = getKreditorById(db, createKreditor(db, { name: 'E AG' }));
  assert.equal(istKreditorVollstaendig(db, ohne), false);
  const mit = getKreditorById(db, kreditorMitIban(db, { name: 'F AG' }));
  assert.equal(istKreditorVollstaendig(db, mit), true);
  const lastschrift = getKreditorById(db, kreditorOhneIbanPflicht(db, { name: 'G AG' }));
  assert.equal(lastschrift.zahlungsart, 'lastschrift');
  assert.equal(istKreditorVollstaendig(db, lastschrift), true);
  db.close();
});

test('listKreditorenWaehlbar contains only active, complete Kreditoren sorted by name', () => {
  const db = openDatabase(':memory:');
  kreditorMitIban(db, { name: 'Zeta' });
  kreditorMitIban(db, { name: 'Alpha', iban: 'CH5604835012345678009' });
  createKreditor(db, { name: 'Unvollstaendig' });
  const inaktiv = kreditorOhneIbanPflicht(db, { name: 'Inaktiv' });
  deactivateKreditor(db, inaktiv);
  kreditorOhneIbanPflicht(db, { name: 'Mitte' });
  assert.deepEqual(listKreditorenWaehlbar(db).map((k) => k.name), ['Alpha', 'Mitte', 'Zeta']);
  db.close();
});

test('migration adds the columns to an existing kreditoren table idempotently', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kred-mig-'));
  const pfad = join(dir, 'p.db');
  try {
    const db = openDatabase(pfad);
    const id = createKreditor(db, { name: 'Alt AG' });
    for (const a of ['INSERT', 'UPDATE', 'DELETE']) db.exec(`DROP TRIGGER audit_kreditoren_${a}`);
    db.exec('ALTER TABLE kreditoren DROP COLUMN zahlungsart');
    db.exec('ALTER TABLE kreditoren DROP COLUMN betrag_schwankt');
    db.close();
    for (let i = 0; i < 2; i++) {
      const db2 = openDatabase(pfad);
      const k = getKreditorById(db2, id);
      assert.equal(k.zahlungsart, 'ueberweisung');
      assert.equal(k.betrag_schwankt, 0);
      db2.close();
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
