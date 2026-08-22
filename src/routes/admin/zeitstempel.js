import { Router } from 'express';
import { getConfigValue, setConfigValue } from '../../db/adminConfigRepo.js';

const URL_PATTERN = /^https?:\/\//;

export function createZeitstempelAdminRouter({ db }) {
  const router = Router();

  function currentState() {
    return {
      tsaUrl: getConfigValue(db, 'zeitstempel_tsa_url') ?? '',
      tsaUser: getConfigValue(db, 'zeitstempel_tsa_user') ?? '',
    };
  }

  router.get('/', (req, res) => {
    res.render('admin/zeitstempel-form', { ...currentState(), errors: [], gespeichert: req.query.gespeichert === '1' });
  });

  router.post('/', (req, res) => {
    const { tsaUrl, tsaUser, tsaPasswort } = req.body;
    const trimmedUrl = (tsaUrl || '').trim();
    const trimmedUser = (tsaUser || '').trim();
    const errors = [];
    if (trimmedUrl && !URL_PATTERN.test(trimmedUrl)) {
      errors.push('TSA-URL muss leer sein (Funktion deaktiviert) oder mit http:// oder https:// beginnen.');
    }

    if (errors.length > 0) {
      return res.status(400).render('admin/zeitstempel-form', {
        tsaUrl: trimmedUrl,
        tsaUser: trimmedUser,
        errors,
        gespeichert: false,
      });
    }

    setConfigValue(db, 'zeitstempel_tsa_url', trimmedUrl);
    setConfigValue(db, 'zeitstempel_tsa_user', trimmedUser);
    setConfigValue(db, 'zeitstempel_tsa_passwort', tsaPasswort || '');
    res.redirect('/admin/zeitstempel?gespeichert=1');
  });

  return router;
}
