import { personHasRole } from './roles.js';
import { personHasPermission } from './permissions.js';

export function loadNavFlags(db, config) {
  return (req, res, next) => {
    const person = req.currentPerson;
    res.locals.isBuchhaltung = personHasRole(person, config, 'buchhaltung');
    res.locals.isSuperadmin = personHasRole(person, config, 'superadmin');
    res.locals.isManager = personHasRole(person, config, 'manager');
    const hasPermission = (permission) => personHasPermission(db, config, person, permission);
    res.locals.adminNav = {
      konten: hasPermission('konten_verwalten'),
      debitoren: hasPermission('debitoren_verwalten'),
      eskalation: res.locals.isSuperadmin,
      erscheinungsbild: res.locals.isSuperadmin,
      zeitstempel: res.locals.isSuperadmin,
      personen: res.locals.isSuperadmin || res.locals.isManager,
      mails: hasPermission('mails_einsehen'),
      sync: hasPermission('sync_einsehen'),
      geplanteJobs: hasPermission('geplante_jobs_verwalten'),
      abgelehnt: hasPermission('abgelehnt_verwalten'),
      auditLog: hasPermission('audit_log_einsehen'),
      backup: res.locals.isSuperadmin,
    };
    res.locals.currentPath = req.path;
    next();
  };
}
