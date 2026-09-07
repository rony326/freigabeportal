import { Router } from 'express';
import { getConfigValue, setConfigValue } from '../../db/adminConfigRepo.js';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Both group tokens are accepted here (not just "gruppe:buchhaltung") because this validator is
// shared with the /admin/sync route, whose "Sync-Fehler-Empfänger" field defaults to
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

export function createEskalationRouter({ db, csrfProtection = (req, res, next) => next() }) {
  const router = Router();

  router.get('/', (req, res) => {
    res.render('admin/eskalation-form', {
      reminderStunden: getConfigValue(db, 'reminder_stunden'),
      eskalationStunden: getConfigValue(db, 'eskalation_stunden'),
      reminderEmpfaenger: getConfigValue(db, 'reminder_empfaenger'),
      eskalationEmpfaenger: getConfigValue(db, 'eskalation_empfaenger'),
      ibanAbweichungEmpfaenger: getConfigValue(db, 'iban_abweichung_empfaenger'),
      freigabe2ReminderStunden: getConfigValue(db, 'freigabe2_reminder_stunden'),
      freigabe2EskalationStunden: getConfigValue(db, 'freigabe2_eskalation_stunden'),
      freigabe2EskalationEmpfaenger: getConfigValue(db, 'freigabe2_eskalation_empfaenger'),
      errors: [],
      gespeichert: req.query.gespeichert === '1',
    });
  });

  router.post('/', csrfProtection, (req, res) => {
    const { reminderStunden, eskalationStunden, reminderEmpfaenger, eskalationEmpfaenger, ibanAbweichungEmpfaenger, freigabe2ReminderStunden, freigabe2EskalationStunden, freigabe2EskalationEmpfaenger } = req.body;
    const errors = [];

    const reminderNum = Number(reminderStunden);
    const eskalationNum = Number(eskalationStunden);
    const freigabe2ReminderNum = Number(freigabe2ReminderStunden);
    const freigabe2EskalationNum = Number(freigabe2EskalationStunden);
    if (!Number.isInteger(reminderNum) || reminderNum <= 0) {
      errors.push('Reminder-Stunden muss eine positive Ganzzahl sein.');
    }
    if (!Number.isInteger(eskalationNum) || eskalationNum <= 0) {
      errors.push('Eskalations-Stunden muss eine positive Ganzzahl sein.');
    }
    if (!Number.isInteger(freigabe2ReminderNum) || freigabe2ReminderNum <= 0) {
      errors.push('Freigabe 2 – Reminder-Stunden muss eine positive Ganzzahl sein.');
    }
    if (!Number.isInteger(freigabe2EskalationNum) || freigabe2EskalationNum <= 0) {
      errors.push('Freigabe 2 – Eskalations-Stunden muss eine positive Ganzzahl sein.');
    }
    validateEmpfaengerListe(reminderEmpfaenger, 'Reminder-Empfänger', errors);
    validateEmpfaengerListe(eskalationEmpfaenger, 'Eskalations-Empfänger', errors);
    validateEmpfaengerListe(ibanAbweichungEmpfaenger, 'IBAN-Abweichungs-Empfänger', errors);
    validateEmpfaengerListe(freigabe2EskalationEmpfaenger, 'Freigabe 2 – Übergabe-Empfänger', errors);

    if (errors.length > 0) {
      return res.status(400).render('admin/eskalation-form', { reminderStunden, eskalationStunden, reminderEmpfaenger, eskalationEmpfaenger, ibanAbweichungEmpfaenger, freigabe2ReminderStunden, freigabe2EskalationStunden, freigabe2EskalationEmpfaenger, errors, gespeichert: false });
    }

    setConfigValue(db, 'reminder_stunden', String(reminderNum));
    setConfigValue(db, 'eskalation_stunden', String(eskalationNum));
    setConfigValue(db, 'reminder_empfaenger', reminderEmpfaenger.trim());
    setConfigValue(db, 'eskalation_empfaenger', eskalationEmpfaenger.trim());
    setConfigValue(db, 'iban_abweichung_empfaenger', ibanAbweichungEmpfaenger.trim());
    setConfigValue(db, 'freigabe2_reminder_stunden', String(freigabe2ReminderNum));
    setConfigValue(db, 'freigabe2_eskalation_stunden', String(freigabe2EskalationNum));
    setConfigValue(db, 'freigabe2_eskalation_empfaenger', freigabe2EskalationEmpfaenger.trim());
    res.redirect('/admin/eskalation?gespeichert=1');
  });

  return router;
}
