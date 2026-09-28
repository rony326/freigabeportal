import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requireApiKey } from '../../../src/middleware/apiKey.js';
import { createN8nBackupRouter } from '../../../src/routes/n8n/backup.js';

function buildTestApp(config) {
  const app = express();
  app.use('/api/n8n/backup', requireApiKey({ n8nApiKey: config.backupApiKey }), createN8nBackupRouter({ config }));
  return app;
}

test('GET /api/n8n/backup/latest without a valid API key returns 401', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'n8n-backup-test-'));
  const app = buildTestApp({ backupApiKey: 'backup-key', backupDir: join(dir, 'backups') });
  const res = await request(app).get('/api/n8n/backup/latest');
  assert.equal(res.status, 401);
  rmSync(dir, { recursive: true, force: true });
});

test('GET /api/n8n/backup/latest returns 404 when no backup exists yet', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'n8n-backup-test-'));
  const app = buildTestApp({ backupApiKey: 'backup-key', backupDir: join(dir, 'backups') });
  const res = await request(app).get('/api/n8n/backup/latest').set('X-API-Key', 'backup-key');
  assert.equal(res.status, 404);
  rmSync(dir, { recursive: true, force: true });
});

test('GET /api/n8n/backup/latest streams the lexicographically newest matching backup file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'n8n-backup-test-'));
  const backupDir = join(dir, 'backups');
  mkdirSync(backupDir, { recursive: true });
  writeFileSync(join(backupDir, 'backup-2026-08-20T03-00-00-000Z.fpbak'), 'alt');
  writeFileSync(join(backupDir, 'backup-2026-08-24T03-00-00-000Z.fpbak'), 'neu');
  writeFileSync(join(backupDir, 'backup-2099-08-24T03-00-00-000Z.zip'), 'legacy plaintext must not be exported');
  writeFileSync(join(backupDir, 'nicht-passend.txt'), 'ignorieren');

  const app = buildTestApp({ backupApiKey: 'backup-key', n8nApiKey: 'n8n-key', backupDir });
  const denied = await request(app).get('/api/n8n/backup/latest').set('X-API-Key', 'n8n-key');
  assert.equal(denied.status, 401);
  const res = await request(app).get('/api/n8n/backup/latest').set('X-API-Key', 'backup-key');
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'application/octet-stream');
  assert.equal(res.headers['content-disposition'], 'attachment; filename="backup-2026-08-24T03-00-00-000Z.fpbak"');
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

test('backup API stays closed when only the workflow credential is configured', async () => {
  const app = buildTestApp({ n8nApiKey: 'n8n-key', backupDir: '/unused' });
  const res = await request(app).get('/api/n8n/backup/latest').set('X-API-Key', 'n8n-key');
  assert.equal(res.status, 401);
});

test('backup API never follows symbolic or hard links to a secret file', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'backup-link-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const backupDir = join(dir, 'backups');
  mkdirSync(backupDir);
  const secret = join(dir, 'keys.json');
  writeFileSync(secret, 'secret material', { mode: 0o600 });
  const target = join(backupDir, 'backup-2026-08-24T03-00-00-000Z.fpbak');
  const app = buildTestApp({ backupApiKey: 'backup-key', backupDir });
  for (const createLink of [symlinkSync, linkSync]) {
    createLink(secret, target);
    const result = await request(app).get('/api/n8n/backup/latest').set('X-API-Key', 'backup-key');
    assert.equal(result.status, 404);
    assert.ok(!result.text.includes('secret material'));
    rmSync(target);
  }
});

test('backup API does not fall back to plaintext legacy ZIPs', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'backup-legacy-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'backup-2026-08-24T03-00-00-000Z.zip'), 'plaintext');
  const response = await request(buildTestApp({ backupApiKey: 'backup-key', backupDir: dir })).get('/api/n8n/backup/latest').set('X-API-Key', 'backup-key');
  assert.equal(response.status, 404);
});
