import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { setBerechtigungenForPerson } from '../../src/db/personBerechtigungenRepo.js';
import { setConfigValue } from '../../src/db/adminConfigRepo.js';
import { loadNavFlags } from '../../src/middleware/nav.js';

const CONFIG = { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20', groupIdManager: '30' } };

function runLoadNavFlags(db, config, currentPerson, path) {
  const req = { currentPerson, path };
  const res = { locals: {} };
  let calledNext = false;
  loadNavFlags(db, config)(req, res, () => {
    calledNext = true;
  });
  return { res, calledNext };
}

test('loadNavFlags sets isBuchhaltung/currentPath for a Buchhaltung member and calls next', () => {
  const db = openDatabase(':memory:');
  const { res, calledNext } = runLoadNavFlags(db, CONFIG, { churchtools_person_id: '1', gruppen: ['10'] }, '/pool');
  assert.equal(res.locals.isBuchhaltung, true);
  assert.equal(res.locals.isSuperadmin, false);
  assert.equal(res.locals.isManager, false);
  assert.equal(res.locals.currentPath, '/pool');
  assert.equal(calledNext, true);
  db.close();
});

test('loadNavFlags sets isSuperadmin true for a Superadmin (ChurchTools Admin group) member', () => {
  const db = openDatabase(':memory:');
  const { res } = runLoadNavFlags(db, CONFIG, { churchtools_person_id: '1', gruppen: ['20'] }, '/admin');
  assert.equal(res.locals.isSuperadmin, true);
  assert.equal(res.locals.isBuchhaltung, false);
  assert.equal(res.locals.adminNav.backup, true);
  db.close();
});

test('loadNavFlags sets isManager true for a Manager group member, and adminNav includes the bundled sections but not the hard-locked ones', () => {
  const db = openDatabase(':memory:');
  const { res } = runLoadNavFlags(db, CONFIG, { churchtools_person_id: '1', gruppen: ['30'] }, '/admin');
  assert.equal(res.locals.isManager, true);
  assert.equal(res.locals.isSuperadmin, false);
  assert.equal(res.locals.adminNav.konten, true);
  assert.equal(res.locals.adminNav.kreditoren, true);
  assert.equal(res.locals.adminNav.mails, true);
  assert.equal(res.locals.adminNav.sync, true);
  assert.equal(res.locals.adminNav.geplanteJobs, true);
  assert.equal(res.locals.adminNav.abgelehnt, true);
  assert.equal(res.locals.adminNav.personen, true);
  assert.equal(res.locals.adminNav.auditLog, true);
  assert.equal(res.locals.adminNav.vorgaenge, true);
  assert.equal(res.locals.adminNav.benachrichtigungen, false);
  assert.equal(res.locals.adminNav.erscheinungsbild, false);
  assert.equal(res.locals.adminNav.zeitstempel, false);
  assert.equal(res.locals.adminNav.backup, false);
  db.close();
});

test('loadNavFlags: a plain person with one individual grant sees only that section in adminNav', () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'A', nachname: 'B', email: 'a@b.ch', gruppen: [], loggedInNow: false });
  setBerechtigungenForPerson(db, '1', ['mails_einsehen']);
  const { res } = runLoadNavFlags(db, CONFIG, { churchtools_person_id: '1', gruppen: [] }, '/admin');
  assert.equal(res.locals.adminNav.mails, true);
  assert.equal(res.locals.adminNav.konten, false);
  assert.equal(res.locals.adminNav.personen, false, 'personen list stays role-only, not grantable via individual rights');
  db.close();
});

test('loadNavFlags sets adminNav.kreditkarten true for a superadmin, and zeigeKreditkarteNav false while the module is disabled', () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'A', nachname: 'B', email: 'a@b.ch', gruppen: ['20'], loggedInNow: false });
  setConfigValue(db, 'modul_kreditkarten_aktiv', '0');
  const { res } = runLoadNavFlags(db, CONFIG, { churchtools_person_id: '1', gruppen: ['20'] }, '/admin');
  assert.equal(res.locals.adminNav.kreditkarten, true);
  assert.equal(res.locals.kreditkartenModulAktiv, false);
  assert.equal(res.locals.zeigeKreditkarteNav, false);
  db.close();
});

test('loadNavFlags sets all flags false and adminNav all-false for an anonymous visitor (currentPerson null)', () => {
  const db = openDatabase(':memory:');
  const { res } = runLoadNavFlags(db, CONFIG, null, '/');
  assert.equal(res.locals.isBuchhaltung, false);
  assert.equal(res.locals.isSuperadmin, false);
  assert.equal(res.locals.isManager, false);
  assert.equal(Object.values(res.locals.adminNav).every((v) => v === false), true);
  db.close();
});

test('loadNavFlags berechnet Banner und Navigation erst beim Lesen (Downloads/JSON sparen die Abfragen)', () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'A', nachname: 'B', email: 'a@b.ch', gruppen: ['10'], loggedInNow: false });
  const { res } = runLoadNavFlags(db, CONFIG, { churchtools_person_id: '1', gruppen: ['10'], aktiv: 1 }, '/pool');
  // Ohne Lesen keine Abfrage: eine kaputte Tabelle fällt erst beim Zugriff auf.
  db.exec('DROP TABLE banner_ausgeblendet; DROP TABLE banner');
  assert.ok(Object.getOwnPropertyDescriptor(res.locals, 'banner').get, 'banner ist ein Getter');
  assert.deepEqual(res.locals.banner, [], 'Rückfall statt Absturz, wenn das Banner nicht lesbar ist');
  assert.equal(res.locals.navigation.bereich, 'portal');
  db.close();
});

test('loadNavFlags: Navigation fällt bei kaputter Datenbank auf null zurück (Fehlerseite rendert weiter)', (t) => {
  t.mock.method(console, 'error', () => {});
  const db = openDatabase(':memory:');
  const { res } = runLoadNavFlags(db, CONFIG, { churchtools_person_id: '1', gruppen: ['10'], aktiv: 1 }, '/pool');
  db.exec('PRAGMA foreign_keys = OFF; DROP TABLE jobs');
  assert.equal(res.locals.navigation, null);
  db.close();
});

test('loadNavFlags übernimmt eine vorab gezählte Aufgabensumme (routes/poolPage.js) statt neu zu zählen', () => {
  const db = openDatabase(':memory:');
  const { res } = runLoadNavFlags(db, CONFIG, { churchtools_person_id: '1', gruppen: ['10'], aktiv: 1 }, '/pool');
  res.locals.offeneAufgabenVorab = 7;
  db.exec('PRAGMA foreign_keys = OFF; DROP TABLE jobs');
  const pool = res.locals.navigation.gruppen.flatMap((g) => g.punkte ?? g.eintraege ?? []).find((p) => p.href === '/pool');
  assert.equal(pool?.zaehler, 7);
  db.close();
});
