import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requireApiKey } from '../../../src/middleware/apiKey.js';
import { createN8nBackupRouter } from '../../../src/routes/n8n/backup.js';

function buildTestApp(config) {
  const app = express();
  app.use('/api/n8n/backup', requireApiKey(config), createN8nBackupRouter({ config }));
  return app;
}

test('GET /api/n8n/backup/latest without a valid API key returns 401', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'n8n-backup-test-'));
  const app = buildTestApp({ n8nApiKey: 'n8n-key', backupDir: join(dir, 'backups') });
  const res = await request(app).get('/api/n8n/backup/latest');
  assert.equal(res.status, 401);
  rmSync(dir, { recursive: true, force: true });
});

test('GET /api/n8n/backup/latest returns 404 when no backup exists yet', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'n8n-backup-test-'));
  const app = buildTestApp({ n8nApiKey: 'n8n-key', backupDir: join(dir, 'backups') });
  const res = await request(app).get('/api/n8n/backup/latest').set('X-API-Key', 'n8n-key');
  assert.equal(res.status, 404);
  rmSync(dir, { recursive: true, force: true });
});

test('GET /api/n8n/backup/latest streams the lexicographically newest matching backup file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'n8n-backup-test-'));
  const backupDir = join(dir, 'backups');
  mkdirSync(backupDir, { recursive: true });
  writeFileSync(join(backupDir, 'backup-2026-08-20T03-00-00-000Z.zip'), 'alt');
  writeFileSync(join(backupDir, 'backup-2026-08-24T03-00-00-000Z.zip'), 'neu');
  writeFileSync(join(backupDir, 'nicht-passend.txt'), 'ignorieren');

  const app = buildTestApp({ n8nApiKey: 'n8n-key', backupDir });
  const res = await request(app).get('/api/n8n/backup/latest').set('X-API-Key', 'n8n-key');
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'application/zip');
  assert.equal(res.headers['content-disposition'], 'attachment; filename="backup-2026-08-24T03-00-00-000Z.zip"');
  // supertest/superagent doesn't reliably populate res.text for a non-text content type like
  // application/zip. For application/zip specifically, res.body is an empty object and res.text
  // contains the streamed content. Check the type first (type-safe pattern) rather than trying
  // Buffer.from() which throws before the || can short-circuit.
  if (Buffer.isBuffer(res.body) || res.body instanceof Uint8Array) {
    assert.ok(Buffer.from(res.body).equals(Buffer.from('neu')));
  } else {
    assert.equal(res.text, 'neu');
  }
  rmSync(dir, { recursive: true, force: true });
});
