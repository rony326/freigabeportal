import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { withAuditActor } from '../../src/services/auditContext.js';
import { auditiereGruppenrechte } from '../../src/services/rechteAudit.js';

// admin_config wird bereits per Trigger auditiert (z. B. das Seeding-Kennzeichen); hier nur Rechte-Einträge.
const eintraege = (db) => db.prepare("SELECT * FROM audit_ereignisse WHERE objekt <> 'admin_config' ORDER BY id").all();

test('Gruppenrechte: Diff schreibt je geändertem Recht einen Eintrag', () => {
  const db = openDatabase(':memory:');
  const anzahl = withAuditActor({ id: '9', name: 'Rony Admin' }, () => auditiereGruppenrechte(db, 'manager', ['a', 'b'], ['b', 'c']));
  assert.equal(anzahl, 2);
  const zeilen = eintraege(db);
  assert.deepEqual(zeilen.map((z) => [z.objekt, z.objekt_id, z.aktion, JSON.parse(z.nachher).recht]).sort(),
    [['gruppenrechte', 'manager', 'recht_entzogen', 'a'], ['gruppenrechte', 'manager', 'recht_erteilt', 'c']]);
  assert.equal(zeilen[0].person_id, '9');
  assert.equal(zeilen[0].person_name, 'Rony Admin');
  db.close();
});

test('gleicher Bestand schreibt nichts', () => {
  const db = openDatabase(':memory:');
  assert.equal(auditiereGruppenrechte(db, 'manager', ['a'], ['a']), 0);
  assert.equal(eintraege(db).length, 0);
  db.close();
});
