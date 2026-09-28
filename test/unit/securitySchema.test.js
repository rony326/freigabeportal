import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { setConfigValue } from '../../src/db/adminConfigRepo.js';
import { auditContext } from '../../src/services/auditContext.js';
import { createJob } from '../../src/db/jobsRepo.js';
import { jobDocument } from '../../src/services/jobDocument.js';
import { requireApiKey } from '../../src/middleware/apiKey.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('audit records historical actor and redacts secret values', (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  auditContext({ currentPerson: { churchtools_person_id: '17', vorname: 'Ada', nachname: 'Test' } }, {}, () => {
    setConfigValue(db, 'zeitstempel_tsa_passwort', 'never-log-this');
    setConfigValue(db, 'zeitstempel_tsa_passwort', 'nor-this');
  });
  const events = db.prepare("SELECT * FROM audit_ereignisse WHERE objekt_id = 'zeitstempel_tsa_passwort' ORDER BY id").all();
  assert.equal(events.length, 2);
  assert.equal(events[1].person_id, '17');
  assert.equal(events[1].person_name, 'Ada Test');
  assert.equal(JSON.parse(events[1].vorher).value, '[redacted]');
  assert.equal(JSON.parse(events[1].nachher).value, '[redacted]');
  assert.doesNotMatch(JSON.stringify(events), /never-log-this|nor-this/);
});

test('audit and business change roll back together; committed events cannot be edited or deleted', (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const count = () => db.prepare('SELECT count(*) AS n FROM audit_ereignisse').get().n;
  const before = count();
  db.exec('BEGIN');
  setConfigValue(db, 'security_test', 'temporary');
  assert.equal(count(), before + 1);
  db.exec('ROLLBACK');
  assert.equal(count(), before);
  assert.equal(db.prepare("SELECT * FROM admin_config WHERE key = 'security_test'").get(), undefined);
  setConfigValue(db, 'security_test', 'persistent');
  assert.throws(() => db.exec("UPDATE audit_ereignisse SET person_name = 'forged'"), /unveraenderlich/);
  assert.throws(() => db.exec('DELETE FROM audit_ereignisse'), /unveraenderlich/);
});

test('approval snapshot and both timestamp hashes resist value-null-value replacement', (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const id = createJob(db, { eingangAm: '2026-09-27T00:00:00Z', quelle: 'scanner', dateiname: 'test.pdf', pdfPfad: '/tmp/test.pdf' });
  for (const column of ['freigabe_snapshot', 'zeitstempel_datei_hash', 'gruppe_zeitstempel_datei_hash', 'zeitstempel_gesetzt_am', 'gruppe_zeitstempel_gesetzt_am']) {
    db.prepare(`UPDATE jobs SET ${column} = ? WHERE id = ?`).run('original', id);
    assert.throws(() => db.prepare(`UPDATE jobs SET ${column} = NULL WHERE id = ?`).run(id), /unveraenderlich/);
    assert.throws(() => db.prepare(`UPDATE jobs SET ${column} = ? WHERE id = ?`).run('replacement', id), /unveraenderlich/);
    assert.equal(db.prepare(`SELECT ${column} AS value FROM jobs WHERE id = ?`).get(id).value, 'original');
  }
});

test('group verification selects group bytes and hash, never the original invoice', () => {
  const doc = jobDocument({ status: 'aufgesplittet', pdf_pfad: 'original.pdf', zeitstempel_datei_hash: 'original', gruppe_pdf_pfad: 'group.pdf', gruppe_zeitstempel_datei_hash: 'group' });
  assert.equal(doc.pdf_pfad, 'group.pdf');
  assert.equal(doc.zeitstempel_datei_hash, 'group');
  assert.equal(jobDocument({ status: 'aufgesplittet', pdf_pfad: 'original.pdf' }).pdf_pfad, undefined);
});

test('unconfigured backup credential rejects requests instead of accepting another key or throwing', () => {
  let status;
  let called = false;
  const response = { status(value) { status = value; return this; }, json() {} };
  requireApiKey({ n8nApiKey: null })({ get: () => 'workflow-key' }, response, () => { called = true; });
  assert.equal(status, 401);
  assert.equal(called, false);
});

const KK_AUDITED_TABLES = ['kreditkarten', 'kreditkarte_erfasser', 'kk_belege'];

function triggerSql(db, name) {
  return db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(name)?.sql;
}

function assertAuditTriggersCurrent(db) {
  for (const table of ['freigaben', 'jobs', 'person_berechtigungen', ...KK_AUDITED_TABLES]) {
    for (const action of ['INSERT', 'UPDATE', 'DELETE']) {
      assert.ok(triggerSql(db, `audit_${table}_${action}`), `audit_${table}_${action} fehlt`);
    }
  }
  for (const column of ['kreditkarte_id', 'kk_eigenbeleg_grund', 'kk_markiert_am', 'kk_erinnert_am', 'kk_text_betraege', 'freigabe_snapshot']) {
    assert.match(triggerSql(db, 'audit_jobs_UPDATE'), new RegExp(`'${column}'`), `jobs UPDATE snapshot ohne ${column}`);
  }
  assert.match(triggerSql(db, 'audit_freigaben_INSERT'), /'vertretung_fuer'/);
}

test('fresh database: audit triggers exist for freigaben, jobs and the credit-card tables, jobs snapshot includes kk columns', (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  assertAuditTriggersCurrent(db);
  const pbSql = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'person_berechtigungen'").get().sql;
  for (const right of ['sync_verwalten', 'workflow_eingreifen', 'kreditkarten_verwalten']) assert.match(pbSql, new RegExp(`'${right}'`));
});

test('credit-card tables and kk jobs columns are audited like the rest of the business data', (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  db.prepare("INSERT INTO personen (churchtools_person_id, vorname, nachname, email) VALUES ('5', 'Karl', 'Karte', 'k@example.ch')").run();
  const karteId = Number(db.prepare("INSERT INTO kreditkarten (bezeichnung, verantwortlich_id, erstellt_am) VALUES ('Firmenkarte', '5', '2026-09-28T00:00:00Z')").run().lastInsertRowid);
  const jobId = createJob(db, { eingangAm: '2026-09-27T00:00:00Z', quelle: 'scanner', dateiname: 'kk.pdf', pdfPfad: '/tmp/kk.pdf' });
  db.prepare('UPDATE jobs SET kreditkarte_id = ? WHERE id = ?').run(karteId, jobId);
  const karteEvent = db.prepare("SELECT * FROM audit_ereignisse WHERE objekt = 'kreditkarten' AND aktion = 'INSERT'").get();
  assert.equal(karteEvent.objekt_id, String(karteId));
  const jobEvent = db.prepare("SELECT * FROM audit_ereignisse WHERE objekt = 'jobs' AND aktion = 'UPDATE' ORDER BY id DESC").get();
  assert.equal(JSON.parse(jobEvent.vorher).kreditkarte_id, null);
  assert.equal(JSON.parse(jobEvent.nachher).kreditkarte_id, karteId);
});

test('pre-feature on-disk database: reopening rebuilds CHECKs without losing audit triggers and refreshes stale jobs snapshots', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'security-schema-upgrade-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, 'portal.db');

  // Build a database in the shape master produced before the credit-card feature: security
  // triggers present, but CHECKs without the kk values and jobs triggers whose frozen snapshot
  // lacks the kk_* columns.
  let db = openDatabase(dbPath);
  db.prepare("INSERT INTO personen (churchtools_person_id, vorname, nachname, email) VALUES ('7', 'Alt', 'Bestand', 'a@example.ch')").run();
  const jobId = createJob(db, { eingangAm: '2026-09-27T00:00:00Z', quelle: 'scanner', dateiname: 'alt.pdf', pdfPfad: '/tmp/alt.pdf' });
  db.prepare("INSERT INTO freigaben (job_id, person_id, rolle, zeitpunkt, ip) VALUES (?, '7', 'freigeber1', '2026-09-27T01:00:00Z', '127.0.0.1')").run(jobId);
  db.exec(`PRAGMA foreign_keys = OFF;
    BEGIN;
    CREATE TABLE person_berechtigungen_alt (
      person_id TEXT NOT NULL REFERENCES personen(churchtools_person_id),
      berechtigung TEXT NOT NULL CHECK (berechtigung IN ('konten_verwalten','debitoren_verwalten','geplante_jobs_verwalten','abgelehnt_verwalten','mails_einsehen','sync_einsehen','audit_log_einsehen','pool_zuweisen','sync_verwalten','workflow_eingreifen')),
      PRIMARY KEY (person_id, berechtigung)
    );
    DROP TABLE person_berechtigungen;
    ALTER TABLE person_berechtigungen_alt RENAME TO person_berechtigungen;
    INSERT INTO person_berechtigungen VALUES ('7', 'sync_verwalten');
    ALTER TABLE freigaben RENAME TO freigaben_tmp;
    CREATE TABLE freigaben (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL REFERENCES jobs(id),
      person_id TEXT NOT NULL REFERENCES personen(churchtools_person_id),
      rolle TEXT NOT NULL CHECK (rolle IN ('freigeber1', 'freigeber2', 'ablehnung', 'freigabe1_eskalation', 'freigabe2_eskalation', 'iban_abweichung', 'rechnungsnummer_duplikat', 'pool_zuweisung', 'pool_ruecksendung', 'freigabe1_weiterleitung')),
      zeitpunkt TEXT NOT NULL, ip TEXT NOT NULL, interessenskonflikt INTEGER NOT NULL DEFAULT 0, kommentar TEXT,
      eskaliert_von TEXT REFERENCES personen(churchtools_person_id), vertretung_fuer TEXT REFERENCES personen(churchtools_person_id)
    );
    INSERT INTO freigaben SELECT * FROM freigaben_tmp;
    DROP TABLE freigaben_tmp;
    CREATE TRIGGER audit_freigaben_INSERT AFTER INSERT ON freigaben BEGIN SELECT 1; END;
    DROP TRIGGER audit_jobs_UPDATE;
    CREATE TRIGGER audit_jobs_UPDATE AFTER UPDATE ON jobs BEGIN INSERT INTO audit_ereignisse
      (zeitpunkt, person_id, person_name, objekt, objekt_id, aktion, vorher, nachher)
      VALUES ('x', 'system', 'System', 'jobs', CAST(NEW.id AS TEXT), 'UPDATE', json_object('id', OLD.id), json_object('id', NEW.id)); END;
    COMMIT;
    PRAGMA foreign_keys = ON;`);
  assert.doesNotMatch(triggerSql(db, 'audit_jobs_UPDATE'), /'kreditkarte_id'/);
  db.close();

  db = openDatabase(dbPath);
  t.after(() => db.close());
  assertAuditTriggersCurrent(db);
  // Rebuilt tables keep their data, and the new CHECK values are accepted.
  assert.equal(db.prepare("SELECT count(*) AS n FROM freigaben WHERE job_id = ?").get(jobId).n, 1);
  assert.deepEqual(db.prepare("SELECT berechtigung FROM person_berechtigungen WHERE person_id = '7'").all().map((r) => r.berechtigung), ['sync_verwalten']);
  db.prepare("INSERT INTO person_berechtigungen VALUES ('7', 'kreditkarten_verwalten')").run();
  db.prepare("INSERT INTO freigaben (job_id, person_id, rolle, zeitpunkt, ip) VALUES (?, '7', 'kk_abgleich', '2026-09-28T00:00:00Z', 'system')").run(jobId);
  const freigabeEvent = db.prepare("SELECT * FROM audit_ereignisse WHERE objekt = 'freigaben' AND aktion = 'INSERT' ORDER BY id DESC").get();
  assert.equal(JSON.parse(freigabeEvent.nachher).rolle, 'kk_abgleich');
  db.prepare("UPDATE jobs SET kk_markiert_am = '2026-09-28T00:00:00Z' WHERE id = ?").run(jobId);
  const jobEvent = db.prepare("SELECT * FROM audit_ereignisse WHERE objekt = 'jobs' AND aktion = 'UPDATE' ORDER BY id DESC").get();
  assert.equal(JSON.parse(jobEvent.nachher).kk_markiert_am, '2026-09-28T00:00:00Z');
});
