import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { AsyncResource } from 'node:async_hooks';
import { openDatabase } from '../../src/db/index.js';
import { migrateAuditRequestSchema } from '../../src/db/auditRequestSchema.js';
import { auditRequestContext, auditContext, currentAuditRequestId, currentAuditActor, machineAuditContext, mitAuditKontext } from '../../src/services/auditContext.js';

function event(db, id) {
  db.prepare(`INSERT INTO audit_ereignisse (zeitpunkt, person_id, person_name, objekt, objekt_id, aktion)
    VALUES ('2026-09-28', ?, ?, 'test', ?, 'changed')`).run(currentAuditActor().id, currentAuditActor().name, id);
}

test('concurrent requests get independent server IDs and actor changes preserve correlation', async (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const app = express();
  app.use(auditRequestContext);
  app.use((req, res, next) => { req.currentPerson = { churchtools_person_id: req.path, vorname: 'Test', nachname: 'Actor' }; next(); });
  app.use(auditContext);
  app.get('/machine', machineAuditContext('service:test', 'Test service'), (req, res) => { event(db, req.path); res.end(); });
  app.get('/human/:id', async (req, res) => {
    await new Promise((resolve) => setTimeout(resolve, Number(req.params.id) % 3));
    event(db, req.path);
    event(db, req.path);
    res.end();
  });
  const paths = ['/machine', ...Array.from({ length: 12 }, (_, i) => `/human/${i}`)];
  const responses = await Promise.all(paths.map((path) => request(app).get(path).set('X-Request-ID', 'client-controlled')));
  const ids = responses.map((response) => response.headers['x-request-id']);
  assert.equal(new Set(ids).size, paths.length);
  for (let i = 0; i < paths.length; i++) {
    assert.match(ids[i], /^[0-9a-f-]{36}$/);
    const rows = db.prepare(`SELECT e.person_id, r.request_id FROM audit_ereignisse e
      JOIN audit_request_zuordnung r ON r.ereignis_id = e.id WHERE e.objekt_id = ?`).all(paths[i]);
    assert.equal(rows.length, i === 0 ? 1 : 2);
    for (const row of rows) {
      assert.equal(row.request_id, ids[i]);
      assert.equal(row.person_id, i === 0 ? 'service:test' : paths[i]);
    }
  }
  assert.equal(currentAuditRequestId(), null);
});

test('upload callback restores both actor and request when invoked by an unrelated async resource', async () => {
  const foreign = new AsyncResource('foreign-stream');
  let id;
  await new Promise((resolve, reject) => auditRequestContext({}, { setHeader(name, value) { id = value; } }, () =>
    machineAuditContext('service:upload', 'Upload')({}, {}, () => {
      const middleware = mitAuditKontext((req, res, callback) => setImmediate(() => foreign.runInAsyncScope(callback)));
      middleware({}, {}, () => {
        try { assert.equal(currentAuditRequestId(), id); assert.equal(currentAuditActor().id, 'service:upload'); resolve(); }
        catch (err) { reject(err); }
      });
    })));
  foreign.emitDestroy();
});

test('correlation is immutable, migration is idempotent and old/background events remain unassigned', () => {
  const db = openDatabase(':memory:');
  try {
    event(db, 'background');
    migrateAuditRequestSchema(db);
    migrateAuditRequestSchema(db);
    auditRequestContext({}, { setHeader() {} }, () => event(db, 'http'));
    assert.equal(db.prepare('SELECT count(*) AS n FROM audit_request_zuordnung').get().n, 1);
    assert.throws(() => db.exec("UPDATE audit_request_zuordnung SET request_id = 'replacement'"), /unveraenderlich/);
    assert.throws(() => db.exec('DELETE FROM audit_request_zuordnung'), /unveraenderlich/);
    db.exec('BEGIN');
    auditRequestContext({}, { setHeader() {} }, () => event(db, 'rolled-back'));
    db.exec('ROLLBACK');
    assert.equal(db.prepare('SELECT count(*) AS n FROM audit_request_zuordnung').get().n, 1);
    db.exec(`CREATE TRIGGER reject_correlation BEFORE INSERT ON audit_request_zuordnung BEGIN SELECT RAISE(ABORT, 'correlation unavailable'); END;`);
    assert.throws(() => auditRequestContext({}, { setHeader() {} }, () => event(db, 'must-not-persist')), /correlation unavailable/);
    assert.equal(db.prepare("SELECT count(*) AS n FROM audit_ereignisse WHERE objekt_id = 'must-not-persist'").get().n, 0);
  } finally { db.close(); }
});
