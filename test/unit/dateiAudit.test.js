import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { openDatabase } from '../../src/db/index.js';
import { loescheDateiMitAudit } from '../../src/services/dateiAudit.js';
import { withAuditActor } from '../../src/services/auditContext.js';

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'datei-audit-'));
  const db = openDatabase(':memory:');
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  return { db, dir };
}
const opts = { objekt: 'jobs', objektId: 5, dateiart: 'beleg_pdf', anlass: 'Test' };
const events = (db) => db.prepare("SELECT * FROM audit_ereignisse WHERE aktion LIKE 'datei_%' ORDER BY id").all()
  .map((row) => ({ ...row, daten: JSON.parse(row.nachher) }));

test('intent with hash precedes deletion; only the file name is recorded', (t) => {
  const { db, dir } = setup(t);
  const pfad = join(dir, 'job-1.pdf');
  writeFileSync(pfad, 'inhalt');
  withAuditActor({ id: 'system', name: 'System' }, () => assert.equal(loescheDateiMitAudit(db, pfad, opts), true));
  assert.equal(existsSync(pfad), false);
  const [intent, done] = events(db);
  assert.equal(intent.aktion, 'datei_loeschung_beabsichtigt');
  assert.equal(intent.daten.sha256, createHash('sha256').update('inhalt').digest('hex'));
  assert.equal(intent.daten.dateiname, 'job-1.pdf');
  assert.equal(done.aktion, 'datei_geloescht');
  assert.equal(intent.daten.operationId, done.daten.operationId);
  assert.ok(!JSON.stringify([intent, done]).includes(dir));
});

test('missing file is a no-op; audit failure keeps the file; symlinks and directories are not removed', (t) => {
  const { db, dir } = setup(t);
  assert.equal(loescheDateiMitAudit(db, join(dir, 'fehlt.pdf'), opts), true);
  assert.equal(events(db).length, 0);
  const pfad = join(dir, 'job-2.pdf');
  writeFileSync(pfad, 'x');
  db.exec("CREATE TRIGGER ausfall BEFORE INSERT ON audit_ereignisse WHEN NEW.aktion = 'datei_loeschung_beabsichtigt' BEGIN SELECT RAISE(ABORT, 'audit down'); END;");
  assert.throws(() => loescheDateiMitAudit(db, pfad, opts), /audit down/);
  assert.equal(existsSync(pfad), true);
  db.exec('DROP TRIGGER ausfall');
  const ziel = join(dir, 'ziel.pdf');
  writeFileSync(ziel, 'geschuetzt');
  const link = join(dir, 'link.pdf');
  symlinkSync(ziel, link);
  assert.equal(loescheDateiMitAudit(db, link, opts), false);
  assert.equal(existsSync(link), true);
  assert.equal(existsSync(ziel), true);
  mkdirSync(join(dir, 'ordner.pdf'));
  assert.equal(loescheDateiMitAudit(db, join(dir, 'ordner.pdf'), opts), false);
  assert.deepEqual(events(db).map((e) => e.aktion), [
    'datei_loeschung_beabsichtigt', 'datei_loeschung_fehlgeschlagen', 'datei_loeschung_beabsichtigt', 'datei_loeschung_fehlgeschlagen',
  ]);
  db.exec('BEGIN');
  assert.throws(() => loescheDateiMitAudit(db, pfad, opts), /Transaktion/);
  db.exec('ROLLBACK');
  assert.throws(() => loescheDateiMitAudit(db, pfad, { ...opts, dateiart: 'beliebig' }), /Dateiart/);
});
