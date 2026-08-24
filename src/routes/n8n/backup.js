import { Router } from 'express';
import { existsSync, readdirSync, statSync, createReadStream } from 'node:fs';
import { join } from 'node:path';
import { BACKUP_DATEINAME_PATTERN } from '../../services/backup.js';

export function createN8nBackupRouter({ config }) {
  const router = Router();

  router.get('/latest', (req, res) => {
    if (!existsSync(config.backupDir)) {
      return res.status(404).json({ error: 'Kein Backup vorhanden.' });
    }
    const dateien = readdirSync(config.backupDir)
      .filter((name) => BACKUP_DATEINAME_PATTERN.test(name))
      .sort();
    if (dateien.length === 0) {
      return res.status(404).json({ error: 'Kein Backup vorhanden.' });
    }
    const neuesteDatei = dateien[dateien.length - 1];
    const pfad = join(config.backupDir, neuesteDatei);
    res.type('application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${neuesteDatei}"`);
    res.setHeader('Content-Length', statSync(pfad).size);
    createReadStream(pfad).pipe(res);
  });

  return router;
}
