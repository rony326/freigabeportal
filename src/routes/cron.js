import { Router } from 'express';
import { runPersonenSync } from '../services/sync.js';
import { hasRecentRunningSync } from '../db/syncLogRepo.js';
import { requireCronSecret } from '../middleware/cronAuth.js';

export function createCronRouter({ db, config }) {
  const router = Router();

  router.post('/sync-personen', requireCronSecret(config), async (req, res) => {
    if (hasRecentRunningSync(db)) {
      return res.status(409).json({ error: 'Ein Sync-Lauf ist bereits aktiv' });
    }
    try {
      const result = await runPersonenSync(db, config.churchtools, config.churchtools.syncServiceToken);
      res.json({ status: 'erfolg', ...result });
    } catch (err) {
      res.status(500).json({ status: 'fehler', error: err.message });
    }
  });

  return router;
}
