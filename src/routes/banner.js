import { Router } from 'express';
import { blendeBannerAus } from '../services/banner.js';

// Referer-Pfad (gleicher Ursprung, ohne Query) oder /pool.
function zielPfad(req, config) {
  const referer = req.get('referer');
  if (!referer || !config.publicBaseUrl) return '/pool';
  try {
    const url = new URL(referer);
    if (url.origin !== new URL(config.publicBaseUrl).origin) return '/pool';
    return url.pathname.startsWith('/') && !url.pathname.startsWith('//') ? url.pathname : '/pool';
  } catch {
    return '/pool';
  }
}

export function createBannerRouter({ db, config, csrfProtection = (req, res, next) => next() }) {
  const router = Router();
  router.post('/:id/ausblenden', csrfProtection, (req, res) => {
    const id = Number(req.params.id);
    const ergebnis = Number.isInteger(id) ? blendeBannerAus(db, id, req.currentPerson.churchtools_person_id) : 'nicht_gefunden';
    if (ergebnis === 'nicht_gefunden') return res.status(404).render('error', { message: 'Banner nicht gefunden.' });
    if (ergebnis === 'nicht_wegklickbar') return res.status(400).render('error', { message: 'Dieser Hinweis kann nicht ausgeblendet werden.' });
    res.redirect(zielPfad(req, config));
  });
  return router;
}
