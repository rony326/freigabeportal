import { Router } from 'express';
import { blendeBannerAus } from '../services/banner.js';
import { portalPfad } from '../services/nutzung.js';

export function createBannerRouter({ db, csrfProtection = (req, res, next) => next() }) {
  const router = Router();
  router.post('/:id/ausblenden', csrfProtection, (req, res) => {
    const id = Number(req.params.id);
    const ergebnis = Number.isInteger(id) ? blendeBannerAus(db, id, req.currentPerson.churchtools_person_id) : 'nicht_gefunden';
    if (ergebnis === 'nicht_gefunden') return res.status(404).render('error', { message: 'Banner nicht gefunden.' });
    if (ergebnis === 'nicht_wegklickbar') return res.status(400).render('error', { message: 'Dieser Hinweis kann nicht ausgeblendet werden.' });
    // Rücksprung aus dem versteckten Feld (Referer wird nie gesendet), sonst /pool.
    res.redirect(portalPfad(req.body.zurueck) || '/pool');
  });
  return router;
}
