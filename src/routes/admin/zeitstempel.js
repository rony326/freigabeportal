import { Router } from 'express';
import { getConfigValue, setConfigValue } from '../../db/adminConfigRepo.js';

const URL_PATTERN = /^https?:\/\//;

export function createZeitstempelAdminRouter({ db }) {
  const router = Router();

  function currentState() {
    return {
      tsaUrl: getConfigValue(db, 'zeitstempel_tsa_url') ?? '',
      tsaUser: getConfigValue(db, 'zeitstempel_tsa_user') ?? '',
      warnungAbStunden: getConfigValue(db, 'zeitstempel_warnung_ab_stunden') ?? '',
    };
  }

  router.get('/', (req, res) => {
    res.render('admin/zeitstempel-form', { ...currentState(), errors: [], gespeichert: req.query.gespeichert === '1' });
  });

  router.post('/', (req, res) => {
    const { tsaUrl, tsaUser, tsaPasswort, warnungAbStunden } = req.body;
    const trimmedUrl = (tsaUrl || '').trim();
    const trimmedUser = (tsaUser || '').trim();
    const trimmedWarnung = (warnungAbStunden || '').trim();
    const errors = [];
    if (trimmedUrl && !URL_PATTERN.test(trimmedUrl)) {
      errors.push('TSA-URL muss leer sein (Funktion deaktiviert) oder mit http:// oder https:// beginnen.');
    }
    if (!/^[1-9][0-9]*$/.test(trimmedWarnung)) {
      errors.push('Warnschwelle (Stunden) muss eine ganze Zahl grösser als 0 sein.');
    }

    if (errors.length > 0) {
      return res.status(400).render('admin/zeitstempel-form', {
        tsaUrl: trimmedUrl,
        tsaUser: trimmedUser,
        warnungAbStunden: trimmedWarnung,
        errors,
        gespeichert: false,
      });
    }

    setConfigValue(db, 'zeitstempel_tsa_url', trimmedUrl);
    setConfigValue(db, 'zeitstempel_tsa_user', trimmedUser);
    setConfigValue(db, 'zeitstempel_tsa_passwort', tsaPasswort || '');
    setConfigValue(db, 'zeitstempel_warnung_ab_stunden', trimmedWarnung);
    res.redirect('/admin/zeitstempel?gespeichert=1');
  });

  return router;
}
