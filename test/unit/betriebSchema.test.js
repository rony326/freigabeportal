import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { setBerechtigungenForPerson } from '../../src/db/personBerechtigungenRepo.js';
import { GRANTABLE_BERECHTIGUNGEN, BERECHTIGUNG_LABELS, personHasPermission } from '../../src/middleware/permissions.js';

const CONFIG = { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20', groupIdManager: '30' } };
const TABELLEN = ['nutzung_seitenaufrufe', 'nutzung_geraete', 'nutzung_anmeldungen', 'betrieb_fehler', 'betrieb_fehlermeldungen', 'banner', 'banner_ausgeblendet'];
const mailInsert = (typ) => `INSERT INTO mail_log (typ, job_id, empfaenger, betreff, text, status, versucht_am) VALUES ('${typ}', NULL, 'x@example.org', 'B', 'T', 'eingereiht', '2026-10-01')`;

test('Tabellen vorhanden', () => {
  const db = openDatabase(':memory:');
  for (const t of TABELLEN) assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t), t);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'nutzung_seitenaufrufe_person_idx'").get());
  db.close();
});

test('Recht vergebbar, Manager hat es nicht, Superadmin schon', () => {
  const db = openDatabase(':memory:');
  assert.ok(GRANTABLE_BERECHTIGUNGEN.includes('betrieb_einsehen'));
  assert.equal(BERECHTIGUNG_LABELS.betrieb_einsehen, 'Betrieb & Nutzung');
  upsertPerson(db, { id: '1', vorname: 'A', nachname: 'B', email: 'a@b.ch', gruppen: [], loggedInNow: false });
  const plain = { churchtools_person_id: '1', gruppen: [] };
  assert.equal(personHasPermission(db, CONFIG, plain, 'betrieb_einsehen'), false);
  setBerechtigungenForPerson(db, '1', ['betrieb_einsehen']);
  assert.equal(personHasPermission(db, CONFIG, plain, 'betrieb_einsehen'), true);
  assert.equal(personHasPermission(db, CONFIG, { churchtools_person_id: '2', gruppen: ['30'] }, 'betrieb_einsehen'), false);
  assert.equal(personHasPermission(db, CONFIG, { churchtools_person_id: '3', gruppen: ['20'] }, 'betrieb_einsehen'), true);
  db.close();
});

test('mail_log akzeptiert neue Typen', () => {
  const db = openDatabase(':memory:');
  assert.doesNotThrow(() => db.prepare(mailInsert('neues-geraet')).run());
  assert.doesNotThrow(() => db.prepare(mailInsert('fehlermeldung')).run());
  db.close();
});

test('bestehende DB wird erweitert, Daten, Spalten und Index bleiben', () => {
  const dir = mkdtempSync(join(tmpdir(), 'betrieb-schema-'));
  const pfad = join(dir, 'portal.db');
  let db = openDatabase(pfad);
  db.prepare(mailInsert('audit-pruefnummer')).run();
  db.close();
  const raw = new DatabaseSync(pfad);
  const sql = raw.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'mail_log'").get().sql;
  raw.exec('PRAGMA writable_schema = ON');
  raw.prepare("UPDATE sqlite_master SET sql = ? WHERE type = 'table' AND name = 'mail_log'").run(sql.replace(", 'neues-geraet', 'fehlermeldung'", ''));
  raw.exec('PRAGMA writable_schema = OFF');
  raw.close();

  db = openDatabase(pfad);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM mail_log WHERE typ = 'audit-pruefnummer'").get().n, 1);
  assert.doesNotThrow(() => db.prepare(mailInsert('neues-geraet')).run());
  assert.doesNotThrow(() => db.prepare(mailInsert('fehlermeldung')).run());
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'mail_log_zustellung_idx'").get());
  assert.ok(db.prepare("PRAGMA table_info(mail_log)").all().some((c) => c.name === 'versendet_am'));
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('Audit-Trigger für banner und betrieb_fehlermeldungen, keine für Nutzungsdaten', () => {
  const db = openDatabase(':memory:');
  const trig = (t) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?").all(t).map((r) => r.name).sort();
  assert.deepEqual(trig('banner'), ['audit_banner_DELETE', 'audit_banner_INSERT', 'audit_banner_UPDATE']);
  assert.equal(trig('betrieb_fehlermeldungen').length, 3);
  for (const t of ['nutzung_seitenaufrufe', 'nutzung_geraete', 'nutzung_anmeldungen', 'betrieb_fehler']) assert.deepEqual(trig(t), [], t);
  db.prepare("INSERT INTO banner (art, text, von, bis) VALUES ('info', 'Hallo', '2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z')").run();
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_ereignisse WHERE objekt = 'banner'").get().n, 1);
  assert.throws(() => db.prepare("INSERT INTO banner (art, text, von, bis) VALUES ('info', 'x', '2026-10-02', '2026-10-01')").run());
  db.close();
});
