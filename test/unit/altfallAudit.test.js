import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/db/index.js';
import { createJob } from '../../src/db/jobsRepo.js';
import { auditRequestContext, withAuditActor } from '../../src/services/auditContext.js';

function seed(db) {
  db.prepare("INSERT OR IGNORE INTO personen (churchtools_person_id, vorname, nachname, email) VALUES ('17', 'Ada', 'Test', 'ada@example.org')").run();
  return createJob(db, { eingangAm: '2026-09-29T00:00:00Z', quelle: 'scanner', dateiname: 'alt.pdf', pdfPfad: '/tmp/alt.pdf' });
}

function decide(db, jobId, decision = 'nur_archiv') {
  return Number(db.prepare(`INSERT INTO altfall_entscheidungen
    (job_id, entscheidung, angezeigte_daten, stand, person_id, person_name, begruendung, zeitpunkt)
    VALUES (?, ?, ?, ?, '17', 'Ada Test', 'Beleg und Bestand geprueft', '2026-09-29T12:00:00Z')`)
    .run(jobId, decision, JSON.stringify({ zahlung: { freigegeben: decision === 'nachbestaetigt' } }), 'frozen-state').lastInsertRowid);
}

for (const decision of ['nur_archiv', 'nachbestaetigt']) {
  test(`Altfall ${decision} records complete immutable evidence, actor and request correlation`, (t) => {
    const db = openDatabase(':memory:');
    t.after(() => db.close());
    const jobId = seed(db);
    let id, requestId;
    auditRequestContext({}, { setHeader(name, value) { requestId = value; } }, () =>
      withAuditActor({ id: '17', name: 'Ada Test' }, () => { id = decide(db, jobId, decision); }));
    const events = db.prepare("SELECT * FROM audit_ereignisse WHERE objekt = 'altfall_entscheidungen'").all();
    assert.equal(events.length, 1);
    assert.equal(events[0].objekt_id, String(id));
    assert.equal(events[0].aktion, 'INSERT');
    assert.equal(events[0].person_id, '17');
    assert.equal(events[0].person_name, 'Ada Test');
    assert.equal(events[0].vorher, null);
    const row = db.prepare('SELECT * FROM altfall_entscheidungen WHERE id = ?').get(id);
    assert.deepEqual(JSON.parse(events[0].nachher), { ...row });
    assert.equal(db.prepare('SELECT request_id FROM audit_request_zuordnung WHERE ereignis_id = ?').get(events[0].id).request_id, requestId);
    assert.throws(() => db.prepare("UPDATE altfall_entscheidungen SET begruendung = 'changed' WHERE id = ?").run(id), /unveraenderlich/);
    assert.throws(() => db.prepare('DELETE FROM altfall_entscheidungen WHERE id = ?').run(id), /unveraenderlich/);
    assert.equal(db.prepare("SELECT count(*) AS n FROM audit_ereignisse WHERE objekt = 'altfall_entscheidungen'").get().n, 1);
  });
}

test('Altfall decision, audit and correlation roll back together; audit failure blocks the decision', (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const jobId = seed(db);
  db.exec('BEGIN');
  auditRequestContext({}, { setHeader() {} }, () => decide(db, jobId));
  assert.equal(db.prepare("SELECT count(*) AS n FROM audit_ereignisse WHERE objekt = 'altfall_entscheidungen'").get().n, 1);
  db.exec('ROLLBACK');
  assert.equal(db.prepare('SELECT count(*) AS n FROM altfall_entscheidungen').get().n, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM audit_ereignisse WHERE objekt = 'altfall_entscheidungen'").get().n, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM audit_request_zuordnung').get().n, 0);
  db.exec("CREATE TRIGGER reject_altfall_audit BEFORE INSERT ON audit_ereignisse WHEN NEW.objekt = 'altfall_entscheidungen' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;");
  assert.throws(() => decide(db, jobId), /audit unavailable/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM altfall_entscheidungen').get().n, 0);
});

test('reopening existing database adds Altfall audit triggers without inventing historical events', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'altfall-audit-upgrade-'));
  let db = openDatabase(join(dir, 'db.sqlite'));
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  for (const action of ['INSERT', 'UPDATE', 'DELETE']) db.exec(`DROP TRIGGER audit_altfall_entscheidungen_${action}`);
  const oldId = decide(db, seed(db));
  const oldRow = { ...db.prepare('SELECT * FROM altfall_entscheidungen WHERE id = ?').get(oldId) };
  db.close();
  db = openDatabase(join(dir, 'db.sqlite'));
  assert.deepEqual({ ...db.prepare('SELECT * FROM altfall_entscheidungen WHERE id = ?').get(oldId) }, oldRow);
  assert.equal(db.prepare("SELECT count(*) AS n FROM audit_ereignisse WHERE objekt = 'altfall_entscheidungen'").get().n, 0);
  for (const action of ['INSERT', 'UPDATE', 'DELETE']) assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(`audit_altfall_entscheidungen_${action}`));
  const newId = decide(db, seed(db));
  assert.equal(db.prepare("SELECT objekt_id FROM audit_ereignisse WHERE objekt = 'altfall_entscheidungen'").get().objekt_id, String(newId));
  db.close();
  db = openDatabase(join(dir, 'db.sqlite'));
  assert.equal(db.prepare("SELECT count(*) AS n FROM audit_ereignisse WHERE objekt = 'altfall_entscheidungen'").get().n, 1);
});
