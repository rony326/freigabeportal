import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/db/index.js';
import { createKreditor } from '../../src/db/kreditorenRepo.js';
import { reiheMailEin } from '../../src/services/mailZustellung.js';

// S4: Migration für den Mailtyp iban-aenderung (mail_log-CHECK) und die Spalte kreditor_ibans.erstellt_von.
test('Alte Datenbank: Zeilen bleiben, erstellt_von = NULL (alt), Mailtyp iban-aenderung erlaubt, Wiederöffnen idempotent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'iban-aenderung-'));
  const pfad = join(dir, 'portal.db');
  let db = openDatabase(pfad);
  const kreditorId = createKreditor(db, { name: 'Muster AG', kontoId: null, zahlungsart: 'lastschrift' });
  db.prepare("INSERT INTO kreditor_ibans (kreditor_id, iban, quelle, erstellt_am) VALUES (?, 'CH9300762011623852957', 'manuell', '2026-01-01T00:00:00.000Z')").run(kreditorId);
  reiheMailEin(db, { typ: 'zuweisung', jobId: null, empfaenger: 'a@example.org', betreff: 'b', text: 't' });
  db.close();

  // Stand vor der Änderung: mail_log-CHECK ohne iban-aenderung, kreditor_ibans ohne erstellt_von.
  const raw = new DatabaseSync(pfad);
  raw.exec('PRAGMA foreign_keys = OFF');
  const sql = raw.prepare("SELECT sql FROM sqlite_master WHERE name = 'mail_log'").get().sql;
  const alt = sql.replace(", 'iban-aenderung'", '').replace('CREATE TABLE mail_log', 'CREATE TABLE mail_log_neu');
  assert.ok(!alt.includes('iban-aenderung'));
  raw.exec(alt);
  raw.exec('INSERT INTO mail_log_neu SELECT * FROM mail_log; DROP TABLE mail_log; ALTER TABLE mail_log_neu RENAME TO mail_log;');
  // Die Audit-Trigger kennen die Spalte; sie werden beim Öffnen neu angelegt (migrateSecuritySchema).
  for (const { name } of raw.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'kreditor_ibans'").all()) raw.exec(`DROP TRIGGER ${name}`);
  raw.exec('ALTER TABLE kreditor_ibans DROP COLUMN erstellt_von');
  assert.throws(() => raw.exec("INSERT INTO mail_log (typ, empfaenger, betreff, text, status, versucht_am) VALUES ('iban-aenderung', 'a', 'b', 't', 'eingereiht', 'z')"));
  raw.close();

  for (let durchgang = 0; durchgang < 2; durchgang += 1) {
    db = openDatabase(pfad);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM mail_log WHERE typ = \'zuweisung\'').get().n, 1, 'bestehende Mail bleibt');
    const ibanZeile = db.prepare('SELECT * FROM kreditor_ibans').get();
    assert.equal(ibanZeile.erstellt_von, null, 'bestehende IBAN: Erfasser unbekannt');
    assert.equal(ibanZeile.erstellt_am, '2026-01-01T00:00:00.000Z');
    assert.doesNotThrow(() => reiheMailEin(db, { typ: 'iban-aenderung', jobId: null, empfaenger: 'a@example.org', betreff: 'b', text: 't' }));
    db.close();
  }
  rmSync(dir, { recursive: true, force: true });
});
