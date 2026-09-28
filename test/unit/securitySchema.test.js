import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { setConfigValue } from '../../src/db/adminConfigRepo.js';
import { auditContext } from '../../src/services/auditContext.js';
import { createJob } from '../../src/db/jobsRepo.js';
import { jobDocument } from '../../src/services/jobDocument.js';
import { requireApiKey } from '../../src/middleware/apiKey.js';

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
