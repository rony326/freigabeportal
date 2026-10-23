import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/db/index.js';
import { getConfigValue, seedDefaults } from '../../src/db/adminConfigRepo.js';
import { erstelleAuditExportPaket } from '../../src/services/auditExport.js';

function legePaketAn(db) {
  db.prepare(`INSERT INTO audit_ereignisse (zeitpunkt, person_id, person_name, objekt, objekt_id, aktion, nachher)
    VALUES ('2026-10-01T00:00:00Z', 'system', 'System', 'test', '1', 'test', '{"a":1}')`).run();
  const paket = erstelleAuditExportPaket(db);
  assert.ok(paket, 'Paket erwartet');
  return paket.manifest.paketNr;
}

test('frische DB: audit_export_zeitstempel existiert und ist unveraenderlich', () => {
  const db = openDatabase(':memory:');
  const nr = legePaketAn(db);
  db.prepare("INSERT INTO audit_export_zeitstempel (paket_nr, token, gen_time, nachweis, erstellt_am) VALUES (?, ?, ?, ?, ?)")
    .run(nr, Buffer.from([1, 2, 3]), '2026-10-01T10:00:00.000Z', '{}', '2026-10-01T10:00:01.000Z');
  assert.throws(() => db.prepare('UPDATE audit_export_zeitstempel SET nachweis = ?').run('x'), /unveraenderlich/);
  assert.throws(() => db.prepare('DELETE FROM audit_export_zeitstempel').run(), /unveraenderlich/);
  assert.throws(() => db.prepare("INSERT INTO audit_export_zeitstempel (paket_nr, token, gen_time, nachweis, erstellt_am) VALUES (?, ?, ?, ?, ?)")
    .run(nr, Buffer.from([1]), 'a', 'b', 'c'), /UNIQUE|PRIMARY/);
  db.close();
});

test('mail_log akzeptiert typ audit-pruefnummer', () => {
  const db = openDatabase(':memory:');
  assert.doesNotThrow(() => db.prepare("INSERT INTO mail_log (typ, job_id, empfaenger, betreff, text, status, versucht_am) VALUES ('audit-pruefnummer', NULL, 'x@example.org', 'B', 'T', 'eingereiht', '2026-10-01')").run());
  db.close();
});

test('bestehende DB ohne audit-pruefnummer im CHECK wird erweitert, Daten bleiben', () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-pn-schema-'));
  const pfad = join(dir, 'portal.db');
  let db = openDatabase(pfad);
  db.prepare("INSERT INTO mail_log (typ, job_id, empfaenger, betreff, text, status, versucht_am) VALUES ('duplikat-warnung', NULL, 'x@example.org', 'B', 'T', 'eingereiht', '2026-10-01')").run();
  db.close();

  const raw = new DatabaseSync(pfad);
  const sql = raw.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'mail_log'").get().sql;
  raw.exec('PRAGMA writable_schema = ON');
  raw.prepare("UPDATE sqlite_master SET sql = ? WHERE type = 'table' AND name = 'mail_log'").run(sql.replace(", 'audit-pruefnummer'", ''));
  raw.exec('PRAGMA writable_schema = OFF');
  raw.close();

  db = openDatabase(pfad);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM mail_log WHERE typ = 'duplikat-warnung'").get().n, 1);
  assert.doesNotThrow(() => db.prepare("INSERT INTO mail_log (typ, job_id, empfaenger, betreff, text, status, versucht_am) VALUES ('audit-pruefnummer', NULL, 'x@example.org', 'B', 'T', 'eingereiht', '2026-10-01')").run());
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'mail_log_zustellung_idx'").get());
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('Standardvorlage enthaelt Paketnummer, Pruefnummer und Pruefungslink', () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  const text = getConfigValue(db, 'mail_vorlage_audit_pruefnummer_text');
  assert.match(text, /%paketNr%/);
  assert.match(text, /%pruefnummer%/);
  assert.match(text, /%link%/);
  assert.equal(getConfigValue(db, 'modul_audit_nachweis_aktiv'), '1');
  assert.equal(getConfigValue(db, 'audit_pruefnummer_rhythmus'), 'monatlich');
  db.close();
});
