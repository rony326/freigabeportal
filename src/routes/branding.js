import { Router } from 'express';
import { createReadStream, existsSync } from 'node:fs';
import { getConfigValue } from '../db/adminConfigRepo.js';

export function createBrandingRouter({ db }) {
  const router = Router();

  function liefereLogo(pfadKey, mimetypeKey) {
    return (req, res) => {
      const pfad = getConfigValue(db, pfadKey);
      const mimetype = getConfigValue(db, mimetypeKey);
      if (!pfad || !mimetype || !existsSync(pfad)) {
        return res.status(404).end();
      }
      res.type(mimetype);
      createReadStream(pfad).pipe(res);
    };
  }

  router.get('/logo', liefereLogo('branding_logo_pfad', 'branding_logo_mimetype'));
  // Optionales zweites Logo für den Dunkelmodus.
  router.get('/logo-dunkel', liefereLogo('branding_logo_dunkel_pfad', 'branding_logo_dunkel_mimetype'));

  return router;
}
