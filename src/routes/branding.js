import { Router } from 'express';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { getConfigValue } from '../db/adminConfigRepo.js';

// Versionierte Abrufe (?v=… aus loadBranding, ändert sich mit jeder neuen Logo-Datei) darf der
// Browser einen Tag lang ohne Rückfrage verwenden; ohne Version nur nach Revalidierung (ETag /
// Last-Modified → 304), damit ein neu hochgeladenes Logo sofort sichtbar ist.
const CACHE_VERSIONIERT = 'private, max-age=86400';
const CACHE_OHNE_VERSION = 'private, no-cache';

export function createBrandingRouter({ db }) {
  const router = Router();

  function liefereLogo(pfadKey, mimetypeKey) {
    return (req, res, next) => {
      const pfad = getConfigValue(db, pfadKey);
      const mimetype = getConfigValue(db, mimetypeKey);
      if (!pfad || !mimetype || !existsSync(pfad)) {
        return res.status(404).end();
      }
      res.type(mimetype);
      // sendFile setzt ETag und Last-Modified und beantwortet If-None-Match/If-Modified-Since mit 304.
      // Gespeichert wird der Pfad so, wie BRANDING_DIR ihn vorgibt (Standard relativ:
      // './data/branding'); sendFile verlangt einen absoluten Pfad.
      res.sendFile(resolve(pfad), {
        cacheControl: false,
        headers: { 'Cache-Control': req.query.v ? CACHE_VERSIONIERT : CACHE_OHNE_VERSION, 'Content-Type': mimetype },
      }, (err) => {
        if (err && !res.headersSent) next(err);
      });
    };
  }

  router.get('/logo', liefereLogo('branding_logo_pfad', 'branding_logo_mimetype'));
  // Optionales zweites Logo für den Dunkelmodus.
  router.get('/logo-dunkel', liefereLogo('branding_logo_dunkel_pfad', 'branding_logo_dunkel_mimetype'));

  return router;
}
