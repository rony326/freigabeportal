import { Router } from 'express';
import { getConfigValue, setConfigValue } from '../../db/adminConfigRepo.js';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function createEskalationRouter({ db }) {
  const router = Router();

  router.get('/', (req, res) => {
    res.render('admin/eskalation-form', {
      reminderStunden: getConfigValue(db, 'reminder_stunden'),
      eskalationStunden: getConfigValue(db, 'eskalation_stunden'),
      eskalationFallbackEmail: getConfigValue(db, 'eskalation_fallback_email'),
      errors: [],
    });
  });

  router.post('/', (req, res) => {
    const { reminderStunden, eskalationStunden, eskalationFallbackEmail } = req.body;
    const errors = [];

    const reminderNum = Number(reminderStunden);
    const eskalationNum = Number(eskalationStunden);
    if (!Number.isInteger(reminderNum) || reminderNum <= 0) {
      errors.push('Reminder-Stunden muss eine positive Ganzzahl sein.');
    }
    if (!Number.isInteger(eskalationNum) || eskalationNum <= 0) {
      errors.push('Eskalations-Stunden muss eine positive Ganzzahl sein.');
    }
    if (!EMAIL_PATTERN.test(eskalationFallbackEmail || '')) {
      errors.push('Eskalations-Fallback-E-Mail muss eine gültige E-Mail-Adresse sein.');
    }

    if (errors.length > 0) {
      return res.status(400).render('admin/eskalation-form', { reminderStunden, eskalationStunden, eskalationFallbackEmail, errors });
    }

    setConfigValue(db, 'reminder_stunden', String(reminderNum));
    setConfigValue(db, 'eskalation_stunden', String(eskalationNum));
    setConfigValue(db, 'eskalation_fallback_email', eskalationFallbackEmail);
    res.redirect('/admin/eskalation');
  });

  return router;
}
