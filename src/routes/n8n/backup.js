import { Router } from 'express';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ENCRYPTED_BACKUP_DATEINAME_PATTERN } from '../../services/backup.js';
import { openBackupDownload } from '../../services/backupDownload.js';

export function createN8nBackupRouter({ config }) {
  const router = Router();

  router.get('/latest', (req, res) => {
    if (!existsSync(config.backupDir)) {
      return res.status(404).json({ error: 'Kein Backup vorhanden.' });
    }
    const dateien = readdirSync(config.backupDir)
      .filter((name) => ENCRYPTED_BACKUP_DATEINAME_PATTERN.test(name))
      .sort();
    if (dateien.length === 0) {
      return res.status(404).json({ error: 'Kein Backup vorhanden.' });
    }
    const neuesteDatei = dateien[dateien.length - 1];
    const pfad = join(config.backupDir, neuesteDatei);
    let download;
    try { download = openBackupDownload(pfad); }
    catch { return res.status(404).json({ error: 'Kein lesbares Backup vorhanden.' }); }
    res.type('application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${neuesteDatei}"`);
    res.setHeader('Content-Length', download.size);
    download.stream.on('error', () => res.destroy());
    res.on('close', () => download.stream.destroy());
    download.stream.pipe(res);
  });

  return router;
}
