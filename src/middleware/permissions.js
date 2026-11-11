import { personHasRole, verweigereNichtAngemeldet, verweigereOhneBerechtigung } from './roles.js';
import { listBerechtigungenForPerson, personHasBerechtigung } from '../db/personBerechtigungenRepo.js';

export { GRANTABLE_BERECHTIGUNGEN, BERECHTIGUNG_LABELS } from '../services/berechtigungKatalog.js';

// Superadmin und Manager bekommen jedes vergebbare Recht über ihr Rollen-Bundle, unabhängig von
// person_berechtigungen -- Einzelrechte sind nur für alle anderen relevant (additiv, siehe Design).
const NICHT_IM_MANAGER_BUNDLE = ['sync_verwalten', 'workflow_eingreifen', 'betrieb_einsehen'];

export function personHasPermission(db, config, person, permission) {
  if (!person) return false;
  if (personHasRole(person, config, 'superadmin')) return true;
  if (personHasRole(person, config, 'manager') && !NICHT_IM_MANAGER_BUNDLE.includes(permission)) return true;
  return personHasBerechtigung(db, person.churchtools_person_id, permission);
}

// Gleiche Regeln wie personHasPermission, aber die Einzelrechte der Person werden nur einmal (und
// erst bei Bedarf) geladen -- für Stellen, die viele Rechte nacheinander prüfen (Navigation).
export function erstellePermissionPruefer(db, config, person) {
  if (!person) return () => false;
  const istSuperadmin = personHasRole(person, config, 'superadmin');
  const istManager = personHasRole(person, config, 'manager');
  let einzelrechte = null;
  return (permission) => {
    if (istSuperadmin) return true;
    if (istManager && !NICHT_IM_MANAGER_BUNDLE.includes(permission)) return true;
    einzelrechte ??= new Set(listBerechtigungenForPerson(db, person.churchtools_person_id));
    return einzelrechte.has(permission);
  };
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
