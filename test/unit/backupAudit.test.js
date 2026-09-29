import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/db/index.js';
import { deleteBackupWithAudit, listUnresolvedBackupDeletions, reviewBackupDeletion } from '../../src/services/backupAudit.js';
import { withAuditActor, auditRequestContext } from '../../src/services/auditContext.js';

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'backup-audit-'));
  const db = openDatabase(':memory:');
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const path = join(dir, 'backup-2026-09-28T00-00-00-000Z.fpbak');
  return { db, path };
}

test('backup deletion records correlated intent and success with the actual actor', (t) => {
  const { db, path } = setup(t);
  writeFileSync(path, 'backup');
  let requestId;
  auditRequestContext({}, { setHeader(name, id) { requestId = id; } }, () =>
    withAuditActor({ id: 'admin:17', name: 'Admin' }, () => deleteBackupWithAudit(db, path, 'Manual deletion')));
  assert.equal(existsSync(path), false);
  const rows = db.prepare(`SELECT e.*, r.request_id FROM audit_ereignisse e JOIN audit_request_zuordnung r ON r.ereignis_id = e.id WHERE e.objekt = 'backup' ORDER BY e.id`).all();
  assert.deepEqual(rows.map((row) => row.aktion), ['backup_loeschung_beabsichtigt', 'backup_geloescht']);
  for (const row of rows) { assert.equal(row.person_id, 'admin:17'); assert.equal(row.request_id, requestId); }
  assert.equal(JSON.parse(rows[0].nachher).operationId, JSON.parse(rows[1].nachher).operationId);
});

test('no deletion without a durable intent or inside a rollbackable transaction', (t) => {
  const { db, path } = setup(t);
  writeFileSync(path, 'backup');
  db.exec('BEGIN');
  assert.throws(() => deleteBackupWithAudit(db, path, 'Retention'), /Transaktion/);
  db.exec('ROLLBACK');
  assert.equal(existsSync(path), true);
  db.exec("CREATE TRIGGER reject_backup_audit BEFORE INSERT ON audit_ereignisse BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;");
  assert.throws(() => deleteBackupWithAudit(db, path, 'Retention'), /audit unavailable/);
  assert.equal(existsSync(path), true);
});

test('filesystem failure is paired with intent and never claims successful deletion', (t) => {
  const { db, path } = setup(t);
  mkdirSync(path);
  assert.throws(() => deleteBackupWithAudit(db, path, 'Retention'), /regulaere/);
  assert.equal(existsSync(path), true);
  const events = db.prepare("SELECT aktion FROM audit_ereignisse WHERE objekt = 'backup' ORDER BY id").all();
  assert.deepEqual(events.map((row) => row.aktion), ['backup_loeschung_beabsichtigt', 'backup_loeschung_fehlgeschlagen']);
});

test('completion audit failure leaves intent for reconciliation rather than a false failure event', (t) => {
  const { db, path } = setup(t);
  writeFileSync(path, 'backup');
  db.exec("CREATE TRIGGER reject_completion BEFORE INSERT ON audit_ereignisse WHEN NEW.aktion = 'backup_geloescht' BEGIN SELECT RAISE(ABORT, 'completion unavailable'); END;");
  assert.throws(() => deleteBackupWithAudit(db, path, 'Retention'), /completion unavailable/);
  assert.equal(existsSync(path), false);
  const events = db.prepare("SELECT aktion FROM audit_ereignisse WHERE objekt = 'backup'").all();
  assert.deepEqual(events.map((row) => row.aktion), ['backup_loeschung_beabsichtigt']);
  assert.equal(listUnresolvedBackupDeletions(db).length, 1);
});

test('unresolved query pairs by operation and filename, tolerates malformed evidence and paginates', (t) => {
  const { db } = setup(t);
  const insert = (name, action, json) => Number(db.prepare(`INSERT INTO audit_ereignisse
    (zeitpunkt, person_id, person_name, objekt, objekt_id, aktion, nachher)
    VALUES ('2026-09-28', 'system', 'System', 'backup', ?, ?, ?)`).run(name, action, json).lastInsertRowid);
  const intent = 'backup_loeschung_beabsichtigt';
  insert('a', intent, '{"operationId":"done"}');
  insert('a', 'backup_geloescht', '{"operationId":"done"}');
  insert('b', intent, '{"operationId":"failed"}');
  insert('b', 'backup_loeschung_fehlgeschlagen', '{"operationId":"failed"}');
  const open = insert('a', intent, '{"operationId":"open"}');
  insert('other-file', 'backup_geloescht', '{"operationId":"open"}');
  const malformed = insert('malformed', intent, 'not JSON');
  const withoutId = insert('missing-id', intent, '{}');
  assert.deepEqual(listUnresolvedBackupDeletions(db).map((row) => row.id), [withoutId, malformed, open]);
  assert.deepEqual(listUnresolvedBackupDeletions(db, { limit: 1 }).map((row) => row.id), [withoutId]);
  assert.deepEqual(listUnresolvedBackupDeletions(db, { before: withoutId, limit: 1 }).map((row) => row.id), [malformed]);
  assert.throws(() => listUnresolvedBackupDeletions(db, { limit: -1 }));
  assert.throws(() => listUnresolvedBackupDeletions(db, { limit: 101 }));
  assert.throws(() => listUnresolvedBackupDeletions(db, { before: Infinity }));
});

function unresolved(db, filename) {
  return Number(db.prepare(`INSERT INTO audit_ereignisse
    (zeitpunkt, person_id, person_name, objekt, objekt_id, aktion, nachher)
    VALUES ('2026-09-28', 'system', 'System', 'backup', ?, 'backup_loeschung_beabsichtigt', '{}')`).run(filename).lastInsertRowid);
}

test('manual review appends an attributed statement without changing the file or original event', (t) => {
  const { db, path } = setup(t);
  writeFileSync(path, 'keep');
  const id = unresolved(db, 'same-file');
  const otherId = unresolved(db, 'same-file');
  const original = db.prepare('SELECT * FROM audit_ereignisse WHERE id = ?').get(id);
  let reviewId;
  withAuditActor({ id: 'admin:17', name: 'Administrator' }, () => {
    reviewId = reviewBackupDeletion(db, id, 'datei_vorhanden', 'Dateibestand im Wartungsfenster kontrolliert.');
  });
  assert.equal(existsSync(path), true);
  assert.deepEqual(db.prepare('SELECT * FROM audit_ereignisse WHERE id = ?').get(id), original);
  assert.deepEqual(listUnresolvedBackupDeletions(db).map((row) => row.id), [otherId]);
  const review = db.prepare('SELECT * FROM audit_ereignisse WHERE id = ?').get(reviewId);
  assert.equal(review.person_id, 'admin:17');
  assert.equal(review.aktion, 'backup_loeschung_geprueft');
  assert.deepEqual(JSON.parse(review.nachher), { intentId: id, operationId: null, observation: 'datei_vorhanden', evidence: 'administrator_statement' });
  assert.throws(() => reviewBackupDeletion(db, id, 'datei_nicht_vorhanden', 'Widersprechende erneute Pruefung'), (err) => err.status === 409);
  assert.throws(() => db.prepare('DELETE FROM audit_ereignisse WHERE id = ?').run(reviewId), /unveraenderlich/);
});

test('invalid or failing manual reviews leave the intent unresolved', (t) => {
  const { db } = setup(t);
  const id = unresolved(db, 'backup');
  for (const [intentId, observation, reason] of [
    [id, 'deleted', 'Pruefung abgeschlossen'], [id, 'datei_vorhanden', 'kurz'],
    [id, 'datei_vorhanden', 'x'.repeat(2001)], [id, 'datei_vorhanden', 'invalid\x00reason'],
    [0, 'datei_vorhanden', 'Pruefung abgeschlossen'], [id, 'datei_vorhanden', ['wrong type']],
  ]) assert.throws(() => reviewBackupDeletion(db, intentId, observation, reason), (err) => err.status === 400);
  assert.throws(() => reviewBackupDeletion(db, id + 1000, 'datei_vorhanden', 'Pruefung abgeschlossen'), (err) => err.status === 409);
  db.exec("CREATE TRIGGER reject_review BEFORE INSERT ON audit_ereignisse WHEN NEW.aktion = 'backup_loeschung_geprueft' BEGIN SELECT RAISE(ABORT, 'review unavailable'); END;");
  assert.throws(() => reviewBackupDeletion(db, id, 'datei_nicht_vorhanden', 'Dateibestand wurde kontrolliert.'), /review unavailable/);
  assert.equal(db.isTransaction, false);
  assert.equal(listUnresolvedBackupDeletions(db)[0].id, id);
});
