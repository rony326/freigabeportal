import { Router } from 'express';
import { getConfigValue, setConfigValue } from '../../db/adminConfigRepo.js';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Both group tokens are accepted here (not just "gruppe:buchhaltung") because this validator is
// shared with the /admin/sync route (Task 10), whose "Sync-Fehler-Empfänger" field defaults to
// "gruppe:admin" — see adminConfigRepo's seeded default and notify.js's resolveEmpfaenger, which
// already resolves both tokens.
const GRUPPE_TOKENS = ['gruppe:buchhaltung', 'gruppe:admin'];

export function validateEmpfaengerListe(value, label, errors) {
  const zeilen = (value || '')
    .split('\n')
    .map((zeile) => zeile.trim())
    .filter(Boolean);
  if (zeilen.length === 0) {
    errors.push(`${label} braucht mindestens ein Ziel.`);
    return;
  }
  for (const zeile of zeilen) {
    if (!GRUPPE_TOKENS.includes(zeile) && !EMAIL_PATTERN.test(zeile)) {
      errors.push(`${label}: "${zeile}" ist weder eine gültige E-Mail-Adresse noch "${GRUPPE_TOKENS.join('"/"')}".`);
    }
  }
}

export function createEskalationRouter({ db }) {
  const router = Router();

  router.get('/', (req, res) => {
    res.render('admin/eskalation-form', {
      reminderStunden: getConfigValue(db, 'reminder_stunden'),
      eskalationStunden: getConfigValue(db, 'eskalation_stunden'),
      reminderEmpfaenger: getConfigValue(db, 'reminder_empfaenger'),
      eskalationEmpfaenger: getConfigValue(db, 'eskalation_empfaenger'),
      errors: [],
    });
  });

  router.post('/', (req, res) => {
    const { reminderStunden, eskalationStunden, reminderEmpfaenger, eskalationEmpfaenger } = req.body;
    const errors = [];

    const reminderNum = Number(reminderStunden);
    const eskalationNum = Number(eskalationStunden);
    if (!Number.isInteger(reminderNum) || reminderNum <= 0) {
      errors.push('Reminder-Stunden muss eine positive Ganzzahl sein.');
    }
    if (!Number.isInteger(eskalationNum) || eskalationNum <= 0) {
      errors.push('Eskalations-Stunden muss eine positive Ganzzahl sein.');
    }
    validateEmpfaengerListe(reminderEmpfaenger, 'Reminder-Empfänger', errors);
    validateEmpfaengerListe(eskalationEmpfaenger, 'Eskalations-Empfänger', errors);

    if (errors.length > 0) {
      return res.status(400).render('admin/eskalation-form', { reminderStunden, eskalationStunden, reminderEmpfaenger, eskalationEmpfaenger, errors });
    }

    setConfigValue(db, 'reminder_stunden', String(reminderNum));
    setConfigValue(db, 'eskalation_stunden', String(eskalationNum));
    setConfigValue(db, 'reminder_empfaenger', reminderEmpfaenger.trim());
    setConfigValue(db, 'eskalation_empfaenger', eskalationEmpfaenger.trim());
    res.redirect('/admin/eskalation');
  });

  return router;
}
