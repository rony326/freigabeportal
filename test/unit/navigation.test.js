import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bereichFuerPfad, istAktiv, bauePortalGruppen, baueAdminGruppen } from '../../src/services/navigation.js';

const ADMIN_KEYS = ['vorgaenge', 'konten', 'kreditoren', 'eskalation', 'mailEinstellungen', 'erscheinungsbild', 'zeitstempel', 'personen', 'mails', 'sync', 'geplanteJobs', 'abgelehnt', 'auditLog', 'backup', 'module', 'kreditkarten', 'altfaelle'];
const adminNav = (fn) => Object.fromEntries(ADMIN_KEYS.map((k) => [k, fn(k)]));
const portal = (o = {}) => bauePortalGruppen({ pfad: '/pool', spesenModulAktiv: true, zeigeKreditkarteNav: true, offeneAufgaben: 0, ...o });
const finde = (gruppen, label) => gruppen.flatMap((g) => g.punkte).find((p) => p.label === label);

test('nur mails_einsehen → nur Gruppe Betrieb mit Mail-Protokoll', () => {
  const gruppen = baueAdminGruppen({ pfad: '/admin/mails', adminNav: adminNav((k) => k === 'mails') });
  assert.deepEqual(gruppen.map((g) => g.titel), ['Betrieb']);
  assert.deepEqual(gruppen[0].punkte.map((p) => [p.label, p.aktiv]), [['Mail-Protokoll', true]]);
});

test('Admin-Gruppen in Reihenfolge Vorgänge, Stammdaten, Einstellungen, Betrieb bei allen Rechten', () => {
  const gruppen = baueAdminGruppen({ pfad: '/admin', adminNav: adminNav(() => true) });
  assert.deepEqual(gruppen.map((g) => g.titel), ['Vorgänge', 'Stammdaten', 'Einstellungen', 'Betrieb']);
  assert.deepEqual(gruppen.map((g) => g.punkte.map((p) => p.label)), [
    ['Laufende Vorgänge', 'Abgelehnte Rechnungen', 'Altfälle'],
    ['Konten', 'Kreditoren', 'Kreditkarten', 'Personen'],
    ['Eskalationszeiten', 'Mail-Einstellungen', 'Erscheinungsbild', 'Module', 'Zeitstempel'],
    ['Datenbank-Backup', 'Datei-Quarantäne', 'Mail-Protokoll', 'Sync-Übersicht', 'Geplante Jobs', 'Audit-Log'],
  ]);
  assert.ok(gruppen.flatMap((g) => g.punkte).every((p) => p.symbol && !p.aktiv));
});

test('Admin: Datei-Quarantäne hängt am Flag backup', () => {
  const g = baueAdminGruppen({ pfad: '/x', adminNav: adminNav((k) => k === 'backup') });
  assert.deepEqual(g.flatMap((x) => x.punkte).map((p) => p.href), ['/admin/backup', '/admin/dateiquarantaene']);
});

test('istAktiv: Unterseite markiert, Präfix ohne Pfadgrenze nicht', () => {
  assert.equal(istAktiv('/admin/konten/neu', '/admin/konten'), true);
  assert.equal(istAktiv('/admin/konten', '/admin/konten'), true);
  assert.equal(istAktiv('/kreditkarten', '/kreditkarte'), false);
  assert.equal(istAktiv('/admin', '/admin/konten'), false);
});

test('bereichFuerPfad', () => {
  assert.equal(bereichFuerPfad('/admin'), 'admin');
  assert.equal(bereichFuerPfad('/admin/konten'), 'admin');
  assert.equal(bereichFuerPfad('/administration'), 'portal');
  assert.equal(bereichFuerPfad('/pool'), 'portal');
});

test('Portal: Spesen einreichen fehlt bei inaktivem Modul, Kreditkartenbelege nur mit Flag', () => {
  const voll = portal();
  assert.deepEqual(voll.map((g) => g.titel), ['Arbeit', 'Spesen', 'Belege', 'Persönlich']);
  assert.deepEqual(voll.map((g) => g.punkte.map((p) => p.label)), [
    ['Aufgaben'],
    ['Spesen einreichen', 'Meine Spesen'],
    ['Abgeschlossene Rechnungen', 'Kreditkartenbelege'],
    ['Ferienmodus', 'Zeitstempel prüfen', 'Problem melden', 'Datenschutz'],
  ]);
  assert.ok(finde(voll, 'Spesen einreichen'));
  assert.ok(finde(voll, 'Kreditkartenbelege'));
  const knapp = portal({ spesenModulAktiv: false, zeigeKreditkarteNav: false });
  assert.equal(finde(knapp, 'Spesen einreichen'), undefined);
  assert.equal(finde(knapp, 'Kreditkartenbelege'), undefined);
  assert.ok(finde(knapp, 'Meine Spesen'));
});

test('Portal: aktiver Punkt folgt dem Pfad', () => {
  assert.equal(finde(portal({ pfad: '/pool' }), 'Aufgaben').aktiv, true);
  assert.equal(finde(portal({ pfad: '/pool' }), 'Ferienmodus').aktiv, false);
});

test('Portal: Zähler nur bei offeneAufgaben > 0', () => {
  assert.equal(finde(portal({ offeneAufgaben: 0 }), 'Aufgaben').zaehler, undefined);
  assert.equal(finde(portal({ offeneAufgaben: 3 }), 'Aufgaben').zaehler, 3);
  assert.equal(finde(portal({ offeneAufgaben: 3 }), 'Meine Spesen').zaehler, undefined);
});
