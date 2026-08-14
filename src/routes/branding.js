import { Router } from 'express';
import { createReadStream, existsSync } from 'node:fs';
import { getConfigValue } from '../db/adminConfigRepo.js';

export function createBrandingRouter({ db }) {
  const router = Router();

  router.get('/logo', (req, res) => {
    const pfad = getConfigValue(db, 'branding_logo_pfad');
    const mimetype = getConfigValue(db, 'branding_logo_mimetype');
    if (!pfad || !mimetype || !existsSync(pfad)) {
      return res.status(404).end();
    }
    res.type(mimetype);
    createReadStream(pfad).pipe(res);
  });

  return router;
}
