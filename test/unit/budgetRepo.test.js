import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createKonto } from '../../src/db/kontenRepo.js';
import { getBudget, listBudgetsFuerJahr, setzeBudget, entferneBudget } from '../../src/db/budgetRepo.js';
import { withAuditActor } from '../../src/services/auditContext.js';

function setup() {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'Fritz', nachname: 'Frei', email: 'f@x.ch', gruppen: [], loggedInNow: false });
  const kontoId = createKonto(db, { kontonummer: '4000', bezeichnung: 'Jugend', freigeber1Id: '1', stellvertreter1Id: '1', freigeber2Id: '1', stellvertreter2Id: '1' });
  return { db, kontoId: Number(kontoId) };
}

test('setzeBudget/getBudget: Upsert pro Konto und Jahr', () => {
  const { db, kontoId } = setup();
  assert.equal(getBudget(db, kontoId, 2026), null);
  setzeBudget(db, { kontoId, jahr: 2026, betrag: 5000, personId: '1' });
  assert.equal(getBudget(db, kontoId, 2026), 5000);
  setzeBudget(db, { kontoId, jahr: 2026, betrag: 6000.5, personId: '1' });
  assert.equal(getBudget(db, kontoId, 2026), 6000.5);
  assert.equal(getBudget(db, kontoId, 2025), null);
  const map = listBudgetsFuerJahr(db, 2026);
  assert.equal(map.get(kontoId), 6000.5);
  assert.equal(listBudgetsFuerJahr(db, 2025).size, 0);
  entferneBudget(db, kontoId, 2026);
  assert.equal(getBudget(db, kontoId, 2026), null);
  db.close();
});

test('setzeBudget: negativer Betrag oder ungültiges Jahr wirft', () => {
  const { db, kontoId } = setup();
  assert.throws(() => setzeBudget(db, { kontoId, jahr: 2026, betrag: -1, personId: '1' }));
  assert.throws(() => setzeBudget(db, { kontoId, jahr: 1999, betrag: 1, personId: '1' }));
  assert.throws(() => setzeBudget(db, { kontoId, jahr: 2026, betrag: Number.NaN, personId: '1' }));
  db.close();
});

test('Budgetänderung erzeugt ein Audit-Ereignis', () => {
  const { db, kontoId } = setup();
  withAuditActor({ id: '1', name: 'Fritz Frei' }, () => setzeBudget(db, { kontoId, jahr: 2026, betrag: 100, personId: '1' }));
  const ereignis = db.prepare("SELECT * FROM audit_ereignisse WHERE objekt = 'konto_budgets' ORDER BY id DESC").get();
  assert.ok(ereignis, 'Audit-Ereignis fehlt');
  assert.equal(ereignis.person_id, '1');
  assert.match(ereignis.nachher, /"jahr":2026/);
  db.close();
});
