import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GRUPPEN, GRANTABLE_BERECHTIGUNGEN, FESTE_RECHTE, BERECHTIGUNG_LABELS, BERECHTIGUNG_BEREICHE, startwerteFuerGruppe,
} from '../../src/services/berechtigungKatalog.js';

test('GRUPPEN nennt genau superadmin, manager und buchhaltung', () => {
  assert.deepEqual([...GRUPPEN], ['superadmin', 'manager', 'buchhaltung']);
});

test('Startwerte Superadmin: jedes vergebbare Recht und gruppenrechte_verwalten', () => {
  const werte = startwerteFuerGruppe('superadmin');
  for (const recht of GRANTABLE_BERECHTIGUNGEN) assert.ok(werte.includes(recht), recht);
  assert.ok(werte.includes('gruppenrechte_verwalten'));
});

test('Startwerte Manager: heutiges Bündel plus Personen und Testmodus, ohne die gesperrten Rechte', () => {
  const werte = startwerteFuerGruppe('manager');
  for (const recht of ['konten_verwalten', 'kreditoren_verwalten', 'audit_log_einsehen', 'personen_einsehen', 'testmodus_nutzen']) {
    assert.ok(werte.includes(recht), recht);
  }
  for (const recht of ['sync_verwalten', 'workflow_eingreifen', 'betrieb_einsehen', 'wartungsmodus_schalten', 'backup_verwalten', 'gruppenrechte_verwalten', 'module_verwalten']) {
    assert.ok(!werte.includes(recht), recht);
  }
});

test('Startwerte Buchhaltung sind leer', () => {
  assert.deepEqual(startwerteFuerGruppe('buchhaltung'), []);
});

test('gruppenrechte_verwalten ist ein festes Recht und nicht vergebbar', () => {
  assert.deepEqual([...FESTE_RECHTE], ['gruppenrechte_verwalten']);
  assert.ok(!GRANTABLE_BERECHTIGUNGEN.includes('gruppenrechte_verwalten'));
});

test('jedes Recht hat ein Label und liegt in genau einem Bereich', () => {
  const alle = [...GRANTABLE_BERECHTIGUNGEN, ...FESTE_RECHTE];
  for (const recht of alle) {
    assert.ok(BERECHTIGUNG_LABELS[recht], `Label fehlt: ${recht}`);
    const treffer = BERECHTIGUNG_BEREICHE.filter((b) => b.rechte.includes(recht));
    assert.equal(treffer.length, 1, `Bereich: ${recht}`);
  }
  const imBereich = BERECHTIGUNG_BEREICHE.flatMap((b) => b.rechte);
  assert.equal(new Set(imBereich).size, alle.length);
});

test('die neuen Rechte für bisher rollengebundene Seiten sind vergebbar', () => {
  for (const recht of ['personen_einsehen', 'testmodus_nutzen', 'benachrichtigungen_verwalten', 'erscheinungsbild_verwalten', 'ersteinrichtung_verwalten', 'zeitstempel_verwalten', 'backup_verwalten', 'module_verwalten', 'dateiquarantaene_verwalten', 'wartungsmodus_schalten']) {
    assert.ok(GRANTABLE_BERECHTIGUNGEN.includes(recht), recht);
  }
});
