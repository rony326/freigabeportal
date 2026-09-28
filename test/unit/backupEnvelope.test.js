import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, chmodSync, symlinkSync, linkSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, createHash } from 'node:crypto';
import { createBackupKeyring } from '../helpers/backupKeyring.js';
import { loadBackupKeyring, encryptBackupArchive, decryptBackupArchive, buildEncryptedBackup, validateEncryptedBackup, publishEncryptedBackup } from '../../src/services/backupEnvelope.js';
import { openDatabase } from '../../src/db/index.js';
import { buildBackupArchive } from '../../src/services/backup.js';
import { runDatenbankSicherungJob } from '../../src/services/cronJobs.js';
import { restoreOffline, offlineRestoreStatus } from '../../src/services/offlineRestore.js';

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'backup-envelope-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = { backupKeyringFile: createBackupKeyring(dir), dbPath: join(dir, 'db.sqlite'), jobsDir: join(dir, 'jobs'), brandingDir: join(dir, 'branding'), backupDir: join(dir, 'backups') };
  return { dir, config, keyring: loadBackupKeyring(config) };
}

test('AES-GCM roundtrip uses fresh nonces and exposes no plaintext marker', (t) => {
  const { keyring } = setup(t);
  const plaintext = Buffer.from('confidential backup content and credentials');
  const first = encryptBackupArchive(plaintext, keyring);
  const second = encryptBackupArchive(plaintext, keyring);
  assert.notDeepEqual(first, second);
  assert.equal(first.includes(plaintext), false);
  assert.deepEqual(decryptBackupArchive(first, keyring).plaintext, plaintext);
  assert.equal(decryptBackupArchive(second, keyring).keyId, 'test-key');
});

test('every envelope byte, appended data, truncation and plaintext downgrade are authenticated or rejected', (t) => {
  const { keyring } = setup(t);
  const valid = encryptBackupArchive(Buffer.from('sensitive content'), keyring);
  for (let i = 0; i < valid.length; i++) {
    const changed = Buffer.from(valid);
    changed[i] ^= 1;
    assert.throws(() => decryptBackupArchive(changed, keyring), undefined, `byte ${i}`);
  }
  for (let i = 0; i < valid.length; i++) assert.throws(() => decryptBackupArchive(valid.subarray(0, i), keyring));
  assert.throws(() => decryptBackupArchive(Buffer.concat([valid, Buffer.from([0])]), keyring));
  assert.throws(() => decryptBackupArchive(Buffer.from('PK plaintext ZIP'), keyring), /Klartext/);
});

test('rotation retains decryption of old keys and rejects missing or wrong keys', (t) => {
  const { config, keyring } = setup(t);
  const old = encryptBackupArchive(Buffer.from('old'), keyring);
  const document = JSON.parse(readFileSync(config.backupKeyringFile, 'utf8'));
  document.activeKeyId = 'next-key';
  document.keys.push({ id: 'next-key', keyHex: randomBytes(32).toString('hex') });
  writeFileSync(config.backupKeyringFile, JSON.stringify(document));
  const rotated = loadBackupKeyring(config);
  assert.equal(decryptBackupArchive(old, rotated).plaintext.toString(), 'old');
  const newer = encryptBackupArchive(Buffer.from('new'), rotated);
  assert.equal(decryptBackupArchive(newer, rotated).keyId, 'next-key');
  assert.throws(() => decryptBackupArchive(newer, keyring), /nicht vorhanden/);
  rotated.keys.set('test-key', rotated.keys.get('next-key'));
  assert.throws(() => decryptBackupArchive(old, rotated), /Authentifizierung/);
});

test('keyring requires private regular bounded file outside backed-up trees', (t) => {
  const { dir, config } = setup(t);
  assert.throws(() => loadBackupKeyring({}), /BACKUP_KEYRING_FILE/);
  chmodSync(config.backupKeyringFile, 0o644);
  assert.throws(() => loadBackupKeyring(config), /Schluesselbund/);
  chmodSync(config.backupKeyringFile, 0o600);
  const link = join(dir, 'keys-link');
  symlinkSync(config.backupKeyringFile, link);
  assert.throws(() => loadBackupKeyring({ ...config, backupKeyringFile: link }));
  for (const root of ['jobsDir', 'brandingDir', 'backupDir']) assert.throws(() => loadBackupKeyring({ ...config, [root]: dir }));
  linkSync(config.backupKeyringFile, join(dir, 'hardlink'));
  assert.throws(() => loadBackupKeyring(config));
  rmSync(join(dir, 'hardlink'));
  const original = readFileSync(config.backupKeyringFile);
  for (const content of ['not JSON', '{}', Buffer.alloc(16385), JSON.stringify({ version: 1, activeKeyId: 'x', keys: [{ id: 'x', keyHex: 'secret-value-that-must-not-appear' }] })]) {
    writeFileSync(config.backupKeyringFile, content);
    assert.throws(() => loadBackupKeyring(config), (err) => !err.message.includes('secret-value-that-must-not-appear'));
  }
  writeFileSync(config.backupKeyringFile, original);
  const document = JSON.parse(original);
  document.keys.push(document.keys[0]);
  writeFileSync(config.backupKeyringFile, JSON.stringify(document));
  assert.throws(() => loadBackupKeyring(config));
});

test('encrypted backup keeps inner manifest validation and records authentication', (t) => {
  const { config, keyring } = setup(t);
  const db = openDatabase(config.dbPath);
  t.after(() => db.close());
  const backup = buildEncryptedBackup(db, config);
  const { manifest, authentication, zip } = validateEncryptedBackup(backup, config);
  assert.equal(manifest.formatVersion, 2);
  assert.equal(authentication.keyId, 'test-key');
  assert.equal(zip.getEntries().some((entry) => entry.entryName.includes('keys')), false);
  assert.throws(() => validateEncryptedBackup(encryptBackupArchive(Buffer.from('not ZIP'), keyring), config));
  assert.throws(() => validateEncryptedBackup(buildBackupArchive(db, config), config), /Klartext/);
});

test('failed authentication never stages or activates data even with a matching attacker-supplied SHA256', (t) => {
  const { config } = setup(t);
  const db = openDatabase(config.dbPath);
  const buffer = buildEncryptedBackup(db, config);
  db.close();
  const before = readFileSync(config.dbPath);
  buffer[buffer.length - 1] ^= 1;
  assert.throws(() => restoreOffline(buffer, config, {
    operator: 'test', reason: 'tamper test', expectedSha256: createHash('sha256').update(buffer).digest('hex'),
  }), /Authentifizierung/);
  assert.deepEqual(readFileSync(config.dbPath), before);
  assert.equal(offlineRestoreStatus(config).pointer, null);
  assert.equal(offlineRestoreStatus(config).locked, false);
  assert.equal(existsSync(`${config.dbPath}.generations`), false);
});

test('publication is private and collision-safe and leaves no temporary file', (t) => {
  const { config, keyring } = setup(t);
  mkdirSync(config.backupDir);
  const filename = 'backup.fpbak';
  const bytes = encryptBackupArchive(Buffer.from('complete'), keyring);
  publishEncryptedBackup(config.backupDir, filename, bytes);
  const path = join(config.backupDir, filename);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.throws(() => publishEncryptedBackup(config.backupDir, filename, Buffer.from('replacement')), /EEXIST/);
  assert.deepEqual(readFileSync(path), bytes);
  assert.deepEqual(readdirSync(config.backupDir), [filename]);
});

test('backup job without a key fails closed, preserves existing backups and never publishes ZIP', (t) => {
  const { config } = setup(t);
  mkdirSync(config.backupDir);
  const old = 'backup-2000-01-01T00-00-00-000Z.zip';
  writeFileSync(join(config.backupDir, old), 'old plaintext');
  const db = openDatabase(config.dbPath);
  t.after(() => db.close());
  assert.equal(runDatenbankSicherungJob(db, { ...config, backupKeyringFile: null }).status, 'fehler');
  assert.deepEqual(readdirSync(config.backupDir), [old]);
  const result = runDatenbankSicherungJob(db, config);
  assert.equal(result.status, 'erfolg');
  assert.match(result.dateiname, /\.fpbak$/);
  assert.equal(readFileSync(join(config.backupDir, result.dateiname)).subarray(0, 8).toString(), 'FPBACK01');
  assert.equal(readFileSync(join(config.backupDir, old), 'utf8'), 'old plaintext');
});
