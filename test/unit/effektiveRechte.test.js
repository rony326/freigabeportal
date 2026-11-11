import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { setBerechtigungenForPerson } from '../../src/db/personBerechtigungenRepo.js';
import { setGruppenBerechtigungen, listGruppenBerechtigungen } from '../../src/db/gruppenBerechtigungenRepo.js';
import { gruppenVon } from '../../src/middleware/roles.js';
import {
  personHasPermission, erstellePermissionPruefer, ermittleRechteMitHerkunft, hatIrgendeinAdminRecht,
} from '../../src/middleware/permissions.js';

const CONFIG = { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20', groupIdManager: '30' } };
const person = (id, gruppen) => ({ churchtools_person_id: id, gruppen, aktiv: 1 });

test('gruppenVon liefert alle Gruppen einer Person', () => {
  assert.deepEqual(gruppenVon(person('1', ['20', '10']), CONFIG).sort(), ['buchhaltung', 'superadmin']);
  assert.deepEqual(gruppenVon(person('1', []), CONFIG), []);
  assert.deepEqual(gruppenVon(null, CONFIG), []);
});

test('Manager hat die Startwert-Rechte, aber nicht sync_verwalten', () => {
  const db = openDatabase(':memory:');
  const p = person('1', ['30']);
  assert.equal(personHasPermission(db, CONFIG, p, 'konten_verwalten'), true);
  assert.equal(personHasPermission(db, CONFIG, p, 'sync_verwalten'), false);
  assert.equal(personHasPermission(db, CONFIG, p, 'wartungsmodus_schalten'), false);
  db.close();
});

test('Superadmin ohne workflow_eingreifen in der Gruppe hat es nicht, behält aber gruppenrechte_verwalten', () => {
  const db = openDatabase(':memory:');
  setGruppenBerechtigungen(db, 'superadmin', ['kreditoren_verwalten']);
  const p = person('1', ['20']);
  assert.equal(personHasPermission(db, CONFIG, p, 'workflow_eingreifen'), false);
  assert.equal(personHasPermission(db, CONFIG, p, 'kreditoren_verwalten'), true);
  assert.equal(personHasPermission(db, CONFIG, p, 'gruppenrechte_verwalten'), true);
  db.close();
});

test('gruppenrechte_verwalten hat nur, wer in der Superadmin-Gruppe ist', () => {
  const db = openDatabase(':memory:');
  assert.equal(personHasPermission(db, CONFIG, person('1', ['30']), 'gruppenrechte_verwalten'), false);
  assert.equal(personHasPermission(db, CONFIG, person('1', ['10']), 'gruppenrechte_verwalten'), false);
  db.close();
});

test('Einzelrecht ergänzt Gruppenrechte und ist als direkt markiert', () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'A', nachname: 'B', email: 'a@b.ch', gruppen: ['30'], loggedInNow: false });
  setBerechtigungenForPerson(db, '1', ['workflow_eingreifen']);
  const p = person('1', ['30']);
  assert.equal(personHasPermission(db, CONFIG, p, 'workflow_eingreifen'), true);
  const herkunft = ermittleRechteMitHerkunft(db, CONFIG, p);
  assert.deepEqual(herkunft.get('workflow_eingreifen'), { gruppen: [], direkt: true });
  assert.deepEqual(herkunft.get('konten_verwalten'), { gruppen: ['manager'], direkt: false });
  db.close();
});

test('Person in superadmin und buchhaltung: Rechte werden vereinigt, Herkunft nennt beide Gruppen', () => {
  const db = openDatabase(':memory:');
  setGruppenBerechtigungen(db, 'superadmin', ['kreditoren_verwalten', 'audit_log_einsehen']);
  setGruppenBerechtigungen(db, 'buchhaltung', ['kreditoren_verwalten', 'mails_einsehen']);
  const p = person('1', ['20', '10']);
  // Entzug in Superadmin nimmt das Recht nicht weg, solange Buchhaltung es gibt.
  setGruppenBerechtigungen(db, 'superadmin', ['audit_log_einsehen']);
  assert.equal(personHasPermission(db, CONFIG, p, 'kreditoren_verwalten'), true);
  assert.equal(personHasPermission(db, CONFIG, p, 'mails_einsehen'), true);
  assert.equal(personHasPermission(db, CONFIG, p, 'audit_log_einsehen'), true);
  setGruppenBerechtigungen(db, 'superadmin', ['kreditoren_verwalten', 'audit_log_einsehen']);
  const herkunft = ermittleRechteMitHerkunft(db, CONFIG, p);
  assert.deepEqual(herkunft.get('kreditoren_verwalten').gruppen.sort(), ['buchhaltung', 'superadmin']);
  assert.deepEqual(herkunft.get('gruppenrechte_verwalten'), { gruppen: ['superadmin'], direkt: false });
  assert.equal(herkunft.has('backup_verwalten'), false);
  db.close();
});

test('erstellePermissionPruefer folgt derselben Logik', () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'A', nachname: 'B', email: 'a@b.ch', gruppen: ['10'], loggedInNow: false });
  setGruppenBerechtigungen(db, 'buchhaltung', ['mails_einsehen']);
  setBerechtigungenForPerson(db, '1', ['sync_einsehen']);
  const hat = erstellePermissionPruefer(db, CONFIG, person('1', ['10']));
  assert.equal(hat('mails_einsehen'), true);
  assert.equal(hat('sync_einsehen'), true);
  assert.equal(hat('konten_verwalten'), false);
  assert.equal(erstellePermissionPruefer(db, CONFIG, null)('konten_verwalten'), false);
  db.close();
});

test('hatIrgendeinAdminRecht: Buchhaltung ohne Rechte nein, mit einem Gruppenrecht ja', () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'A', nachname: 'B', email: 'a@b.ch', gruppen: ['10'], loggedInNow: false });
  const p = person('1', ['10']);
  assert.equal(hatIrgendeinAdminRecht(db, CONFIG, p), false);
  setGruppenBerechtigungen(db, 'buchhaltung', ['mails_einsehen']);
  assert.equal(hatIrgendeinAdminRecht(db, CONFIG, p), true);
  assert.deepEqual(listGruppenBerechtigungen(db, 'buchhaltung'), ['mails_einsehen']);
  db.close();
});
