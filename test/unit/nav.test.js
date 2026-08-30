import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { setBerechtigungenForPerson } from '../../src/db/personBerechtigungenRepo.js';
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
  assert.equal(res.locals.adminNav.debitoren, true);
  assert.equal(res.locals.adminNav.mails, true);
  assert.equal(res.locals.adminNav.sync, true);
  assert.equal(res.locals.adminNav.geplanteJobs, true);
  assert.equal(res.locals.adminNav.abgelehnt, true);
  assert.equal(res.locals.adminNav.personen, true);
  assert.equal(res.locals.adminNav.auditLog, true);
  assert.equal(res.locals.adminNav.eskalation, false);
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

test('loadNavFlags sets all flags false and adminNav all-false for an anonymous visitor (currentPerson null)', () => {
  const db = openDatabase(':memory:');
  const { res } = runLoadNavFlags(db, CONFIG, null, '/');
  assert.equal(res.locals.isBuchhaltung, false);
  assert.equal(res.locals.isSuperadmin, false);
  assert.equal(res.locals.isManager, false);
  assert.equal(Object.values(res.locals.adminNav).every((v) => v === false), true);
  db.close();
});
