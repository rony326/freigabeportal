import { parseArgs } from 'node:util';
import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { createHash } from 'node:crypto';
import { loadStorageConfig } from '../config/env.js';
import { ENCRYPTED_BACKUP_MAX_BYTES, validateEncryptedBackup } from '../services/backupEnvelope.js';
import { restoreOffline, rollbackOffline, offlineRestoreStatus } from '../services/offlineRestore.js';

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    archive: { type: 'string' }, sha256: { type: 'string' }, operator: { type: 'string' }, reason: { type: 'string' },
  } });
  const command = positionals[0];
  const config = loadStorageConfig();
  let result;
  if (command === 'status') result = offlineRestoreStatus(config);
  else if (command === 'rollback') result = rollbackOffline(config, values);
  else if (command === 'restore' || command === 'verify') {
    if (!values.archive || !statSync(values.archive).isFile() || statSync(values.archive).size > ENCRYPTED_BACKUP_MAX_BYTES) throw new Error('Eine regulaere Backup-Datei innerhalb des Groessenlimits ist erforderlich (--archive).');
    const buffer = readFileSync(values.archive);
    if (command === 'verify') {
      const { manifest, authentication } = validateEncryptedBackup(buffer, config);
      result = { formatVersion: manifest.formatVersion, authentication, sha256: createHash('sha256').update(buffer).digest('hex'), dateien: manifest.dateien.length };
    } else result = restoreOffline(buffer, config, { ...values, expectedSha256: values.sha256, sourceName: basename(values.archive) });
  } else throw new Error('Befehl erwartet: verify, restore, rollback oder status.');
  console.log(JSON.stringify(result, null, 2));
} catch (err) {
  console.error(`Backup-Wartung fehlgeschlagen: ${err.message}`);
  process.exitCode = 1;
}
