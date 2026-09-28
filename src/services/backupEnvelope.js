import { createCipheriv, createDecipheriv, createSecretKey, randomBytes, randomUUID } from 'node:crypto';
import { openSync, closeSync, fstatSync, readFileSync, realpathSync, existsSync, constants, writeFileSync, fsyncSync, linkSync, unlinkSync } from 'node:fs';
import { resolve, relative, isAbsolute, sep, join } from 'node:path';
import { BACKUP_LIMITS, BackupValidationError, buildBackupArchive, validateBackupArchive } from './backup.js';
import { syncDirectory } from './storageState.js';

const MAGIC = Buffer.from('FPBACK01');
const KEY_ID = /^[A-Za-z0-9_-]{1,64}$/;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
export const ENCRYPTED_BACKUP_MAX_BYTES = BACKUP_LIMITS.archiveBytes + 8 + 1 + 64 + NONCE_BYTES + TAG_BYTES;

function within(path, root) {
  const suffix = relative(root, path);
  return !suffix || !isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`);
}

export function loadBackupKeyring(config) {
  if (!config.backupKeyringFile) throw new BackupValidationError('BACKUP_KEYRING_FILE ist erforderlich; kein unverschluesseltes Backup-Fallback.');
  let fd;
  let bytes;
  try {
    const path = realpathSync(config.backupKeyringFile);
    for (const root of [config.jobsDir, config.brandingDir, config.backupDir].filter(Boolean)) {
      if (within(path, resolve(root)) || existsSync(root) && within(path, realpathSync(root))) {
        throw new Error('Keyring inside backup data');
      }
    }
    fd = openSync(config.backupKeyringFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 16384 || stat.nlink !== 1 || (stat.mode & 0o077) !== 0) throw new Error('Invalid keyring file');
    bytes = readFileSync(fd);
    if (bytes.length > 16384) throw new Error('Keyring too large');
    const document = JSON.parse(bytes.toString('utf8'));
    if (document?.version !== 1 || !KEY_ID.test(document.activeKeyId || '') || !Array.isArray(document.keys) || !document.keys.length || document.keys.length > 16) throw new Error('Invalid keyring');
    const keys = new Map();
    const material = new Set();
    for (const entry of document.keys) {
      if (typeof entry?.id !== 'string' || !KEY_ID.test(entry.id) || keys.has(entry.id) ||
          typeof entry.keyHex !== 'string' || !/^[a-f0-9]{64}$/.test(entry.keyHex) || material.has(entry.keyHex)) throw new Error('Invalid key');
      material.add(entry.keyHex);
      keys.set(entry.id, createSecretKey(Buffer.from(entry.keyHex, 'hex')));
    }
    if (!keys.has(document.activeKeyId)) throw new Error('Missing active key');
    return { activeKeyId: document.activeKeyId, keys };
  } catch {
    // Never include parser input, key material or secret-bearing paths in logs.
    throw new BackupValidationError('Backup-Schluesselbund unlesbar oder ungueltig: separate regulaere Datei, Modus 0600/0400 und gueltiges Format erforderlich.');
  } finally {
    bytes?.fill(0);
    if (fd !== undefined) closeSync(fd);
  }
}

export function encryptBackupArchive(plaintext, keyring) {
  if (!Buffer.isBuffer(plaintext) || plaintext.length > BACKUP_LIMITS.archiveBytes) throw new BackupValidationError('Backup-Archiv ist zu gross oder ungueltig.');
  const id = Buffer.from(keyring.activeKeyId, 'ascii');
  if (!KEY_ID.test(keyring.activeKeyId) || !keyring.keys.has(keyring.activeKeyId)) throw new BackupValidationError('Aktiver Backup-Schluessel fehlt.');
  const nonce = randomBytes(NONCE_BYTES);
  const header = Buffer.concat([MAGIC, Buffer.from([id.length]), id, nonce]);
  const cipher = createCipheriv('aes-256-gcm', keyring.keys.get(keyring.activeKeyId), nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(header);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([header, ciphertext, cipher.getAuthTag()]);
}

export function decryptBackupArchive(buffer, keyring) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 38 || buffer.length > ENCRYPTED_BACKUP_MAX_BYTES || !buffer.subarray(0, 8).equals(MAGIC)) {
    throw new BackupValidationError('Authentifiziertes FPBACK01-Backup erforderlich; Klartext-ZIP und unbekannte Formate sind gesperrt.');
  }
  const idLength = buffer[8];
  const headerLength = 9 + idLength + NONCE_BYTES;
  const id = buffer.subarray(9, 9 + idLength).toString('utf8');
  if (!idLength || idLength > 64 || !KEY_ID.test(id) || buffer.length < headerLength + TAG_BYTES ||
      buffer.length - headerLength - TAG_BYTES > BACKUP_LIMITS.archiveBytes || !keyring.keys.has(id)) {
    throw new BackupValidationError('Backup-Header ungueltig oder Backup-Schluessel nicht vorhanden.');
  }
  let plaintext;
  try {
    const decipher = createDecipheriv('aes-256-gcm', keyring.keys.get(id), buffer.subarray(headerLength - NONCE_BYTES, headerLength), { authTagLength: TAG_BYTES });
    decipher.setAAD(buffer.subarray(0, headerLength));
    decipher.setAuthTag(buffer.subarray(-TAG_BYTES));
    plaintext = decipher.update(buffer.subarray(headerLength, -TAG_BYTES));
    // No ZIP parsing or filesystem writes until the complete authentication tag has verified.
    const final = decipher.final();
    return { plaintext: Buffer.concat([plaintext, final]), keyId: id };
  } catch {
    throw new BackupValidationError('Backup-Authentifizierung fehlgeschlagen: falscher Schluessel oder manipulierte Datei.');
  } finally { plaintext?.fill(0); }
}

export function buildEncryptedBackup(db, config) {
  const keyring = loadBackupKeyring(config);
  const plaintext = buildBackupArchive(db, config);
  try { return encryptBackupArchive(plaintext, keyring); }
  finally { plaintext.fill(0); }
}

export function validateEncryptedBackup(buffer, config) {
  const { plaintext, keyId } = decryptBackupArchive(buffer, loadBackupKeyring(config));
  try {
    return { ...validateBackupArchive(plaintext), authentication: { envelope: 'FPBACK01', algorithm: 'aes-256-gcm', keyId } };
  } catch (err) {
    plaintext.fill(0);
    throw err;
  }
  // AdmZip retains the authenticated buffer for extraction by the caller.
}

export function publishEncryptedBackup(directory, filename, buffer) {
  const temporary = join(directory, `.backup-${randomUUID()}.tmp`);
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    try { writeFileSync(fd, buffer); fsyncSync(fd); } finally { closeSync(fd); }
    // Linking publishes a complete file atomically and cannot overwrite an existing backup.
    linkSync(temporary, join(directory, filename));
  } finally { unlinkSync(temporary); }
  syncDirectory(directory);
}
