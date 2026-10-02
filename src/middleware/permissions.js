import { personHasRole, verweigereNichtAngemeldet, verweigereOhneBerechtigung } from './roles.js';
import { listBerechtigungenForPerson, personHasBerechtigung } from '../db/personBerechtigungenRepo.js';

export const GRANTABLE_BERECHTIGUNGEN = [
  'konten_verwalten',
  'kreditoren_verwalten',
  'geplante_jobs_verwalten',
  'abgelehnt_verwalten',
  'mails_einsehen',
  'sync_einsehen',
  'audit_log_einsehen',
  'pool_zuweisen',
  'kreditkarten_verwalten',
  'sync_verwalten',
  'workflow_eingreifen',
];

export const BERECHTIGUNG_LABELS = {
  konten_verwalten: 'Konten verwalten',
  kreditoren_verwalten: 'Kreditoren verwalten',
  geplante_jobs_verwalten: 'Geplante Jobs verwalten',
  abgelehnt_verwalten: 'Abgelehnte Rechnungen verwalten',
  mails_einsehen: 'Mail-Protokoll einsehen',
  sync_einsehen: 'Sync-Übersicht einsehen',
  audit_log_einsehen: 'Globales Audit-Log einsehen',
  pool_zuweisen: 'Pool-Belege an Personen zuweisen',
  kreditkarten_verwalten: 'Kreditkarten verwalten',
  sync_verwalten: 'Sync konfigurieren',
  workflow_eingreifen: 'Blockierte Vorgaenge bearbeiten',
};

// Superadmin und Manager bekommen jedes vergebbare Recht über ihr Rollen-Bundle, unabhängig von
// person_berechtigungen -- Einzelrechte sind nur für alle anderen relevant (additiv, siehe Design).
export function personHasPermission(db, config, person, permission) {
  if (!person) return false;
  if (personHasRole(person, config, 'superadmin')) return true;
  if (personHasRole(person, config, 'manager') && !['sync_verwalten', 'workflow_eingreifen'].includes(permission)) return true;
  return personHasBerechtigung(db, person.churchtools_person_id, permission);
}

export function requirePermission(db, config, permission) {
  return (req, res, next) => {
    const person = req.currentPerson;
    if (!person || !person.aktiv) return verweigereNichtAngemeldet(req, res);
    if (!personHasPermission(db, config, person, permission)) return verweigereOhneBerechtigung(req, res, 'fehlendes_recht', permission);
    next();
  };
}

export function requireAdminAreaAccess(db, config) {
  return (req, res, next) => {
    const person = req.currentPerson;
    if (!person || !person.aktiv) return verweigereNichtAngemeldet(req, res);
    const hatZugriff =
      personHasRole(person, config, 'superadmin') ||
      personHasRole(person, config, 'manager') ||
      listBerechtigungenForPerson(db, person.churchtools_person_id).length > 0;
    if (!hatZugriff) return verweigereOhneBerechtigung(req, res, 'kein_adminbereich');
    next();
  };
}
