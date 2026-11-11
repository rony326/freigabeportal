import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/db/index.js';
import { withAuditActor } from '../../src/services/auditContext.js';
import { istWartungsmodusAktiv, wartungsHinweis, setzeWartungsmodus } from '../../src/services/wartungsmodus.js';

const auditZeilen = (db) => db.prepare("SELECT objekt_id, aktion, person_id, nachher FROM audit_ereignisse WHERE objekt = 'admin_config' AND objekt_id LIKE 'wartungsmodus_%' ORDER BY id").all();

test('Standard: Wartungsmodus aus, kein Hinweis', () => {
  const db = openDatabase(':memory:');
  assert.equal(istWartungsmodusAktiv(db), false);
  assert.equal(wartungsHinweis(db), '');
  db.close();
});

test('ein, aus, ein: Zustand und Hinweis folgen', () => {
  const db = openDatabase(':memory:');
  setzeWartungsmodus(db, true, 'Update bis 14:00');
  assert.equal(istWartungsmodusAktiv(db), true);
  assert.equal(wartungsHinweis(db), 'Update bis 14:00');
  setzeWartungsmodus(db, false);
  assert.equal(istWartungsmodusAktiv(db), false);
  assert.equal(wartungsHinweis(db), '');
  setzeWartungsmodus(db, true);
  assert.equal(istWartungsmodusAktiv(db), true);
  db.close();
});

test('Ein- und Ausschalten ist im Audit-Log (wer, was); unveränderter Zustand schreibt nichts', () => {
  const db = openDatabase(':memory:');
  withAuditActor({ id: '9', name: 'Rony Admin' }, () => {
    setzeWartungsmodus(db, true, 'Update');
    setzeWartungsmodus(db, true, 'Update');
  });
  const zeilen = auditZeilen(db);
  const aktiv = zeilen.filter((z) => z.objekt_id === 'wartungsmodus_aktiv');
  assert.equal(aktiv.length, 1);
  assert.equal(aktiv[0].person_id, '9');
  assert.match(aktiv[0].nachher, /"value":"1"/);
  assert.ok(zeilen.some((z) => z.objekt_id === 'wartungsmodus_hinweis' && /Update/.test(z.nachher)));
  db.close();
});

test('Hinweis wird getrimmt und auf 200 Zeichen gekürzt', () => {
  const db = openDatabase(':memory:');
  setzeWartungsmodus(db, true, `  ${'x'.repeat(300)}  `);
  assert.equal(wartungsHinweis(db).length, 200);
  db.close();
});

test('Zustand überlebt Neuöffnen der Datenbank', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wartung-'));
  try {
    const pfad = join(dir, 'db.sqlite');
    const db = openDatabase(pfad);
    setzeWartungsmodus(db, true, 'Neustart');
    db.close();
    const neu = openDatabase(pfad);
    assert.equal(istWartungsmodusAktiv(neu), true);
    assert.equal(wartungsHinweis(neu), 'Neustart');
    neu.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
