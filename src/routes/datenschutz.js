import { Router } from 'express';
import { getConfigValue } from '../db/adminConfigRepo.js';

export function createDatenschutzRouter({ db }) {
  const router = Router();
  router.get('/', (req, res) => {
    const kontakt = getConfigValue(db, 'betrieb_kontakt_email') || 'die Portal-Administration';
    const text = (getConfigValue(db, 'datenschutz_text') || '').replaceAll('%kontakt%', kontakt);
    res.render('datenschutz', { text });
  });
  return router;
}
