import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { openDatabase } from '../../src/db/index.js';
import { createJob, getJobById } from '../../src/db/jobsRepo.js';
import { setConfigValue, getConfigValue } from '../../src/db/adminConfigRepo.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createKkBeleg, getKkBelegById, markKkBelegDateiGeloescht } from '../../src/db/kkBelegeRepo.js';
import { buildBackupArchive } from '../../src/services/backup.js';
import { buildEncryptedBackup } from '../../src/services/backupEnvelope.js';
import { createBackupKeyring } from '../helpers/backupKeyring.js';
import { restoreOffline, rollbackOffline, offlineRestoreStatus } from '../../src/services/offlineRestore.js';
import { acquireStorageLock, resolveStorageConfig, storagePaths } from '../../src/services/storageState.js';
import { setzeFreigabeSnapshot } from '../helpers/freigabeSnapshot.js';

const restoreModule = new URL('../../src/services/offlineRestore.js', import.meta.url).href;
const cli = fileURLToPath(new URL('../../src/cli/backupRestore.js', import.meta.url));
const index = fileURLToPath(new URL('../../src/index.js', import.meta.url));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'offline-restore-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const backupKeyringFile = createBackupKeyring(dir);
  function paths(name) {
    const root = join(dir, name);
    const config = { dbPath: join(root, 'db.sqlite'), jobsDir: join(root, 'jobs'), brandingDir: join(root, 'branding'), backupDir: join(root, 'backups'), backupKeyringFile };
    for (const path of [config.jobsDir, config.brandingDir, config.backupDir]) mkdirSync(path, { recursive: true });
    return config;
  }
  const source = paths('source');
  const target = paths('target');
  const pdf = Buffer.from('%PDF restored invoice');
  writeFileSync(join(source.jobsDir, 'invoice.pdf'), pdf);
  writeFileSync(join(source.brandingDir, 'logo.png'), 'logo');
  const sourceDb = openDatabase(source.dbPath);
  const jobId = createJob(sourceDb, { eingangAm: '2026-09-27T00:00:00Z', quelle: 'scanner', dateiname: 'invoice.pdf', pdfPfad: join(source.jobsDir, 'invoice.pdf') });
  sourceDb.prepare("UPDATE jobs SET status = 'abgeschlossen', final_datei_hash = ? WHERE id = ?").run(hash(pdf), jobId);
  setzeFreigabeSnapshot(sourceDb, jobId);
  setConfigValue(sourceDb, 'branding_logo_pfad', join(source.brandingDir, 'logo.png'));
  upsertPerson(sourceDb, { id: '1', vorname: 'K', nachname: 'K', email: 'k@example.org', gruppen: [] });
  mkdirSync(join(source.jobsDir, 'kk'));
  writeFileSync(join(source.jobsDir, 'kk', 'beleg.pdf'), 'kk receipt');
  writeFileSync(join(source.jobsDir, 'kk', 'beleg.png'), 'kk thumb');
  const kkBelegId = createKkBeleg(sourceDb, { hochgeladenVon: '1', quelle: 'web', pdfPfad: join(source.jobsDir, 'kk', 'beleg.pdf'), thumbnailPfad: join(source.jobsDir, 'kk', 'beleg.png'), status: 'offen' });
  const kkGeloeschtId = createKkBeleg(sourceDb, { hochgeladenVon: '1', quelle: 'web', pdfPfad: join(source.jobsDir, 'kk', 'weg.pdf'), status: 'verworfen' });
  markKkBelegDateiGeloescht(sourceDb, kkGeloeschtId);
  sourceDb.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run('backup-session', '{}', '2099-01-01');
  const archive = buildEncryptedBackup(sourceDb, source);
  sourceDb.close();
  const targetDb = openDatabase(target.dbPath);
  setConfigValue(targetDb, 'test_generation', 'original');
  targetDb.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run('old-session', '{}', '2099-01-01');
  targetDb.close();
  writeFileSync(join(target.jobsDir, 'keep.pdf'), 'original file');
  const archivePath = join(dir, 'backup.fpbak');
  writeFileSync(archivePath, archive);
  const options = { expectedSha256: hash(archive), operator: 'Test Operator', reason: 'Disaster recovery test', sourceName: 'backup.zip' };
  const env = { ...process.env, DB_PATH: target.dbPath, JOBS_DIR: target.jobsDir, BRANDING_DIR: target.brandingDir, BACKUP_DIR: target.backupDir, BACKUP_KEYRING_FILE: backupKeyringFile };
  return { dir, source, target, archive, archivePath, jobId, kkBelegId, kkGeloeschtId, pdf, options, env };
}

function serverEnv(s) {
  const secret = 'test-only-32-character-secret-value-12345';
  return { ...s.env, NODE_ENV: 'test', SMTP_HOST: '', SESSION_SECRET: secret, N8N_API_KEY: secret, BACKUP_API_KEY: '', DOWNLOAD_SIGNING_SECRET: secret, CRON_SECRET: secret,
    PUBLIC_BASE_URL: 'https://portal.example.org', CT_BASE_URL: 'https://ct.example.org', CT_CLIENT_ID: 'client', CT_CLIENT_SECRET: secret,
    CT_REDIRECT_URI: 'https://portal.example.org/auth/callback', CT_GROUP_ID_BUCHHALTUNG: '10', CT_GROUP_ID_ADMIN: '20',
    CT_SYNC_SERVICE_TOKEN: secret, CT_CUSTOM_FIELD_IBAN: 'iban', CT_CUSTOM_FIELD_KONTOINHABER: 'holder' };
}

test('offline restore activates only a complete generation and keeps original files byte-identical', (t) => {
  const s = setup(t);
  const oldBytes = readFileSync(s.target.dbPath);
  const restored = restoreOffline(s.archive, s.target, s.options);
  assert.deepEqual(readFileSync(s.target.dbPath), oldBytes);
  assert.equal(readFileSync(join(s.target.jobsDir, 'keep.pdf'), 'utf8'), 'original file');
  assert.deepEqual(resolveStorageConfig(s.target), { ...s.target, ...restored.current });
  assert.equal(offlineRestoreStatus(s.target).locked, false);
  const db = openDatabase(restored.current.dbPath);
  try {
    const job = getJobById(db, s.jobId);
    assert.equal(job.pdf_pfad, join(restored.current.jobsDir, 'invoice.pdf'));
    assert.deepEqual(readFileSync(job.pdf_pfad), s.pdf);
    assert.equal(getConfigValue(db, 'branding_logo_pfad'), join(restored.current.brandingDir, 'logo.png'));
    const kk = getKkBelegById(db, s.kkBelegId);
    assert.equal(kk.pdf_pfad, join(restored.current.jobsDir, 'kk', 'beleg.pdf'));
    assert.equal(kk.thumbnail_pfad, join(restored.current.jobsDir, 'kk', 'beleg.png'));
    assert.equal(readFileSync(kk.pdf_pfad, 'utf8'), 'kk receipt');
    const geloescht = getKkBelegById(db, s.kkGeloeschtId);
    assert.equal(geloescht.pdf_pfad, null);
    assert.equal(geloescht.thumbnail_pfad, null);
    assert.equal(db.prepare('SELECT count(*) AS n FROM sessions').get().n, 0);
    const audit = db.prepare("SELECT * FROM audit_ereignisse WHERE aktion = 'offline_restore_vorbereitet'").get();
    assert.equal(audit.person_name, s.options.operator);
    assert.equal(audit.begruendung, s.options.reason);
    assert.equal(audit.objekt_id, s.options.expectedSha256);
    assert.doesNotThrow(() => buildBackupArchive(db, { ...s.target, ...restored.current }));
  } finally { db.close(); }
});

test('active storage lock rejects restore and a second process without changing the pointer', (t) => {
  const s = setup(t);
  const lock = acquireStorageLock(s.target);
  try {
    assert.throws(() => restoreOffline(s.archive, s.target, s.options), /gesperrt/);
    const child = spawnSync(process.execPath, [cli, 'restore', '--archive', s.archivePath, '--sha256', s.options.expectedSha256, '--operator', 'child', '--reason', 'test'], { env: s.env, encoding: 'utf8', timeout: 10000 });
    assert.notEqual(child.status, 0);
    assert.match(child.stderr, /gesperrt/);
    assert.equal(existsSync(lock.pointerPath), false);
  } finally { lock.release(); }
});

test('normal server entrypoint honors the maintenance lock before opening the DB', (t) => {
  const s = setup(t);
  const lock = acquireStorageLock(s.target, 'maintenance-test');
  try {
    const child = spawnSync(process.execPath, [index], { env: serverEnv(s), encoding: 'utf8', timeout: 10000 });
    assert.notEqual(child.status, 0);
    assert.match(child.stderr, /Datenspeicher ist gesperrt/);
  } finally { lock.release(); }
});

test('wrong archive hash and missing operator never activate or acquire a storage lock', (t) => {
  const s = setup(t);
  assert.throws(() => restoreOffline(s.archive, s.target, { ...s.options, expectedSha256: '0'.repeat(64) }), /SHA-256/);
  assert.throws(() => restoreOffline(s.archive, s.target, { ...s.options, operator: '' }), /Operator/);
  assert.equal(offlineRestoreStatus(s.target).pointer, null);
  assert.equal(offlineRestoreStatus(s.target).locked, false);
});

for (const phase of ['extracted', 'prepared', 'beforeActivation']) {
  test(`failure at ${phase} preserves the original active state and removes staging`, (t) => {
    const s = setup(t);
    const oldBytes = readFileSync(s.target.dbPath);
    assert.throws(() => restoreOffline(s.archive, s.target, { ...s.options, onPhase(value) { if (value === phase) throw new Error('injected failure'); } }), /injected failure/);
    assert.deepEqual(readFileSync(s.target.dbPath), oldBytes);
    assert.equal(offlineRestoreStatus(s.target).pointer, null);
    assert.equal(offlineRestoreStatus(s.target).locked, false);
    assert.deepEqual(readdirSync(storagePaths(s.target).generationsPath), []);
  });
}

test('post-activation failure preserves the selected new generation and the previous state', (t) => {
  const s = setup(t);
  assert.throws(() => restoreOffline(s.archive, s.target, { ...s.options, onPhase(phase) { if (phase === 'activated') throw new Error('injected failure'); } }), /moeglicherweise bereits umgeschaltet/);
  const current = resolveStorageConfig(s.target);
  assert.notEqual(current.dbPath, s.target.dbPath);
  assert.ok(existsSync(current.dbPath));
  assert.ok(existsSync(s.target.dbPath));
  assert.ok(existsSync(join(current.jobsDir, 'invoice.pdf')));
});

for (const phase of ['beforeActivation', 'activated']) {
  test(`SIGKILL at ${phase} leaves a complete selected generation and a non-expiring lock`, (t) => {
    const s = setup(t);
    const script = `import { readFileSync } from 'node:fs';
      import { restoreOffline } from ${JSON.stringify(restoreModule)};
      restoreOffline(readFileSync(process.argv[1]), JSON.parse(process.argv[2]), {
        ...JSON.parse(process.argv[3]), onPhase(phase) { if (phase === process.argv[4]) process.kill(process.pid, 'SIGKILL'); }
      });`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, s.archivePath, JSON.stringify(s.target), JSON.stringify(s.options), phase], { encoding: 'utf8', timeout: 10000 });
    assert.equal(child.signal, 'SIGKILL');
    const state = offlineRestoreStatus(s.target);
    assert.equal(state.locked, true);
    assert.throws(() => acquireStorageLock(s.target), /gesperrt/);
    if (phase === 'beforeActivation') assert.equal(state.pointer, null);
    else {
      assert.ok(existsSync(state.pointer.current.dbPath));
      assert.ok(existsSync(join(state.pointer.current.jobsDir, 'invoice.pdf')));
    }
    assert.ok(existsSync(s.target.dbPath));
  });
}

test('rollback returns to the previous database, clears old sessions and preserves the restored generation', (t) => {
  const s = setup(t);
  const restored = restoreOffline(s.archive, s.target, s.options);
  const rolledBack = rollbackOffline(s.target, { operator: 'Recovery Operator', reason: 'Rollback test' });
  assert.equal(rolledBack.current.dbPath, s.target.dbPath);
  assert.equal(resolveStorageConfig(s.target).dbPath, s.target.dbPath);
  assert.ok(existsSync(restored.current.dbPath));
  const db = openDatabase(s.target.dbPath);
  try {
    assert.equal(getConfigValue(db, 'test_generation'), 'original');
    assert.equal(db.prepare('SELECT count(*) AS n FROM sessions').get().n, 0);
    assert.ok(db.prepare("SELECT 1 FROM audit_ereignisse WHERE aktion = 'offline_rollback_vorbereitet'").get());
  } finally { db.close(); }
});

test('corrupt pointer fails closed instead of silently falling back to the old DB', (t) => {
  const s = setup(t);
  writeFileSync(storagePaths(s.target).pointerPath, '{broken');
  assert.throws(() => resolveStorageConfig(s.target));
});

test('CLI verifies, restores and reports the generation using only storage configuration', (t) => {
  const s = setup(t);
  const verify = spawnSync(process.execPath, [cli, 'verify', '--archive', s.archivePath], { env: s.env, encoding: 'utf8', timeout: 10000 });
  assert.equal(verify.status, 0, verify.stderr);
  assert.equal(JSON.parse(verify.stdout).sha256, s.options.expectedSha256);
  assert.equal(JSON.parse(verify.stdout).authentication.keyId, 'test-key');
  const restore = spawnSync(process.execPath, [cli, 'restore', '--archive', s.archivePath, '--sha256', s.options.expectedSha256, '--operator', 'CLI operator', '--reason', 'CLI test'], { env: s.env, encoding: 'utf8', timeout: 10000 });
  assert.equal(restore.status, 0, restore.stderr);
  const status = spawnSync(process.execPath, [cli, 'status'], { env: s.env, encoding: 'utf8', timeout: 10000 });
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).locked, false);
  assert.notEqual(JSON.parse(status.stdout).pointer.current.dbPath, s.target.dbPath);
});

test('CLI rejects missing keys and tampering before activation', (t) => {
  const s = setup(t);
  const missing = spawnSync(process.execPath, [cli, 'verify', '--archive', s.archivePath], { env: { ...s.env, BACKUP_KEYRING_FILE: '' }, encoding: 'utf8', timeout: 10000 });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /BACKUP_KEYRING_FILE/);
  const bytes = Buffer.from(s.archive);
  bytes[bytes.length - 1] ^= 1;
  writeFileSync(s.archivePath, bytes);
  const tampered = spawnSync(process.execPath, [cli, 'restore', '--archive', s.archivePath, '--sha256', hash(bytes), '--operator', 'test', '--reason', 'tamper'], { env: s.env, encoding: 'utf8', timeout: 10000 });
  assert.notEqual(tampered.status, 0);
  assert.match(tampered.stderr, /Authentifizierung/);
  assert.equal(offlineRestoreStatus(s.target).pointer, null);
});

test('real server starts on the restored generation and releases its lock after SIGTERM', { timeout: 20000 }, async (t) => {
  const s = setup(t);
  const restored = restoreOffline(s.archive, s.target, s.options);
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const env = { ...serverEnv(s), PORT: String(port) };
  const child = spawn(process.execPath, [index], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Server start timed out: ${output}`)), 10000);
      const finish = (error) => { clearTimeout(timeout); error ? reject(error) : resolve(); };
      child.stderr.on('data', (data) => { output += data; });
      child.stdout.on('data', (data) => { output += data; if (output.includes(`auf Port ${port}`)) finish(); });
      child.once('error', finish);
      child.once('exit', (code) => finish(new Error(`Server exited ${code}: ${output}`)));
    });
    assert.equal(offlineRestoreStatus(s.target).locked, true);
    const response = await fetch(`http://127.0.0.1:${port}/api/n8n/jobs/abholbereit`, { headers: { 'X-API-Key': env.N8N_API_KEY } });
    assert.equal(response.status, 200);
    assert.equal((await response.json())[0].id, s.jobId);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const done = once(child, 'exit');
      child.kill('SIGTERM');
      await done;
    }
  }
  assert.equal(offlineRestoreStatus(s.target).locked, false);
  const db = openDatabase(restored.current.dbPath);
  try { assert.ok(getJobById(db, s.jobId).fetched_by_n8n_at); } finally { db.close(); }
  const original = openDatabase(s.target.dbPath);
  try { assert.equal(original.prepare('SELECT count(*) AS n FROM jobs').get().n, 0); } finally { original.close(); }
});
