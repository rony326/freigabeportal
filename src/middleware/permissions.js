import { personHasRole } from './roles.js';
import { listBerechtigungenForPerson, personHasBerechtigung } from '../db/personBerechtigungenRepo.js';

export const GRANTABLE_BERECHTIGUNGEN = [
  'konten_verwalten',
  'debitoren_verwalten',
  'geplante_jobs_verwalten',
  'abgelehnt_verwalten',
  'mails_einsehen',
  'sync_einsehen',
  'audit_log_einsehen',
];

export const BERECHTIGUNG_LABELS = {
  konten_verwalten: 'Konten verwalten',
  debitoren_verwalten: 'Debitoren verwalten',
  geplante_jobs_verwalten: 'Geplante Jobs verwalten',
  abgelehnt_verwalten: 'Abgelehnte Rechnungen verwalten',
  mails_einsehen: 'Mail-Protokoll einsehen',
  sync_einsehen: 'Sync-Übersicht einsehen',
  audit_log_einsehen: 'Globales Audit-Log einsehen',
};

// Superadmin und Manager bekommen jedes vergebbare Recht über ihr Rollen-Bundle, unabhängig von
// person_berechtigungen -- Einzelrechte sind nur für alle anderen relevant (additiv, siehe Design).
export function personHasPermission(db, config, person, permission) {
  if (!person) return false;
  if (personHasRole(person, config, 'superadmin')) return true;
  if (personHasRole(person, config, 'manager')) return true;
  return personHasBerechtigung(db, person.churchtools_person_id, permission);
}

export function requirePermission(db, config, permission) {
  return (req, res, next) => {
    const person = req.currentPerson;
    if (!person || !person.aktiv) {
      return res.status(401).render('error', { message: 'Bitte melde dich an, um fortzufahren.' });
    }
    if (!personHasPermission(db, config, person, permission)) {
      return res.status(403).render('error', { message: 'Du hast keine Berechtigung für diesen Bereich.' });
    }
    next();
  };
}

export function requireAdminAreaAccess(db, config) {
  return (req, res, next) => {
    const person = req.currentPerson;
    if (!person || !person.aktiv) {
      return res.status(401).render('error', { message: 'Bitte melde dich an, um fortzufahren.' });
    }
    const hatZugriff =
      personHasRole(person, config, 'superadmin') ||
      personHasRole(person, config, 'manager') ||
      listBerechtigungenForPerson(db, person.churchtools_person_id).length > 0;
    if (!hatZugriff) {
      return res.status(403).render('error', { message: 'Du hast keine Berechtigung für diesen Bereich.' });
    }
    next();
  };
}
