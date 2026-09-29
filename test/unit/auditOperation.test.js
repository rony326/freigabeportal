import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { auditedJob } from '../../src/services/auditOperation.js';
import { currentAuditOperation, currentAuditRequestId, auditRequestContext, withAuditActor } from '../../src/services/auditContext.js';
import { runZeitstempelNachholenJob } from '../../src/services/cronJobs.js';

function rows(db) {
  return db.prepare(`SELECT e.*, l.lauf_id, l.lauf_typ, r.request_id FROM audit_ereignisse e
    LEFT JOIN audit_lauf_zuordnung l ON l.ereignis_id = e.id
    LEFT JOIN audit_request_zuordnung r ON r.ereignis_id = e.id WHERE e.objekt = 'hintergrundlauf' ORDER BY e.id`).all();
}

test('parallel jobs preserve unique operation IDs across awaits under the same HTTP request', async (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const seen = [];
  const job = auditedJob('test-job', async () => {
    const before = currentAuditOperation();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(currentAuditOperation().id, before.id);
    seen.push(before.id);
    assert.ok(currentAuditRequestId());
    return { status: 'erfolg' };
  });
  let requestId;
  await auditRequestContext({}, { setHeader(name, value) { requestId = value; } }, () =>
    withAuditActor({ id: 'admin:1', name: 'Administrator' }, () => Promise.all([job(db), job(db)])));
  assert.equal(new Set(seen).size, 2);
  const events = rows(db);
  assert.equal(events.length, 4);
  for (const event of events) {
    assert.equal(event.request_id, requestId);
    assert.equal(event.person_id, 'admin:1');
    assert.ok(seen.includes(event.lauf_id));
  }
  assert.equal(currentAuditOperation(), null);
});

test('sync result stays synchronous, exceptions are correlated without leaking error text', async (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const result = { status: 'uebersprungen' };
  assert.equal(auditedJob('sync', () => result)(db), result);
  assert.throws(() => auditedJob('sync-fail', () => { throw new Error('SECRET'); })(db), /SECRET/);
  await assert.rejects(() => auditedJob('async-fail', async () => { throw new Error('SECRET'); })(db), /SECRET/);
  const events = rows(db);
  assert.equal(events.length, 6);
  assert.equal(events.filter((event) => event.aktion === 'lauf_abgebrochen').length, 2);
  assert.ok(!JSON.stringify(events).includes('SECRET'));
  assert.ok(events.every((event) => event.request_id === null));
});

test('nested jobs restore the parent operation and mappings are immutable', (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const child = auditedJob('child', () => currentAuditOperation().id);
  auditedJob('parent', () => {
    const parent = currentAuditOperation().id;
    assert.notEqual(child(db), parent);
    assert.equal(currentAuditOperation().id, parent);
  })(db);
  assert.throws(() => db.exec('DELETE FROM audit_lauf_zuordnung'), /unveraenderlich/);
  assert.throws(() => db.exec("UPDATE audit_lauf_zuordnung SET lauf_typ = 'changed'"), /unveraenderlich/);
});

test('real retry job receives a fresh operation even when it is skipped', async (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  await runZeitstempelNachholenJob(db, {});
  await runZeitstempelNachholenJob(db, {});
  const events = rows(db);
  assert.equal(events.length, 4);
  assert.equal(new Set(events.map((event) => event.lauf_id)).size, 2);
  assert.ok(events.every((event) => event.lauf_typ === 'zeitstempel-nachholen'));
});

test('job does not start when start audit cannot be persisted', (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  db.exec("CREATE TRIGGER fail_start BEFORE INSERT ON audit_ereignisse BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;");
  let called = false;
  assert.throws(() => auditedJob('blocked', () => { called = true; })(db), /audit unavailable/);
  assert.equal(called, false);
});
