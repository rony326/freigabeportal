import { Router } from 'express';
import { getConfigValue, setConfigValue } from '../../db/adminConfigRepo.js';

export function createModuleRouter({ db, csrfProtection = (req, res, next) => next() }) {
  const router = Router();

  router.get('/', (req, res) => {
    res.render('admin/module-form', {
      spesenAktiv: getConfigValue(db, 'modul_spesen_aktiv') !== '0',
      strikteFreigeber1Pruefung: getConfigValue(db, 'kontierung_strikte_freigeber1_pruefung') === '1',
      gespeichert: req.query.gespeichert === '1',
    });
  });

  router.post('/', csrfProtection, (req, res) => {
    // An unchecked HTML checkbox submits no field at all, so its absence means "off" here —
    // same convention as this app's other on/off admin_config flags (e.g. audit_log_lokale_zeit).
    setConfigValue(db, 'modul_spesen_aktiv', req.body.spesenAktiv ? '1' : '0');
    setConfigValue(db, 'kontierung_strikte_freigeber1_pruefung', req.body.strikteFreigeber1Pruefung ? '1' : '0');
    res.redirect('/admin/module?gespeichert=1');
  });

  return router;
}
