import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export function createBackupKeyring(directory) {
  const path = join(directory, 'backup-keys.json');
  writeFileSync(path, JSON.stringify({ version: 1, activeKeyId: 'test-key', keys: [{ id: 'test-key', keyHex: randomBytes(32).toString('hex') }] }), { mode: 0o600 });
  return path;
}
