import { personHasRole } from './roles.js';
import { personHasPermission } from './permissions.js';
import { getConfigValue } from '../db/adminConfigRepo.js';
import { zeigeKreditkartenBereich } from '../services/kkRechte.js';
import { bereichFuerPfad, bauePortalGruppen, baueAdminGruppen } from '../services/navigation.js';
import { aktiveBanner } from '../services/banner.js';
import { zaehleOffeneAufgaben } from '../services/aufgabenZaehler.js';

export function loadNavFlags(db, config) {
  return (req, res, next) => {
    const person = req.currentPerson;
    res.locals.isBuchhaltung = personHasRole(person, config, 'buchhaltung');
    res.locals.isSuperadmin = personHasRole(person, config, 'superadmin');
    res.locals.isManager = personHasRole(person, config, 'manager');
    const hasPermission = (permission) => personHasPermission(db, config, person, permission);
    res.locals.adminNav = {
      vorgaenge: hasPermission('vorgaenge_einsehen'),
      konten: hasPermission('konten_verwalten'),
      kreditoren: hasPermission('kreditoren_verwalten'),
      eskalation: res.locals.isSuperadmin,
      mailEinstellungen: res.locals.isSuperadmin,
      erscheinungsbild: res.locals.isSuperadmin,
      zeitstempel: res.locals.isSuperadmin,
      personen: res.locals.isSuperadmin || res.locals.isManager,
      mails: hasPermission('mails_einsehen'),
      sync: hasPermission('sync_einsehen'),
      geplanteJobs: hasPermission('geplante_jobs_verwalten'),
      abgelehnt: hasPermission('abgelehnt_verwalten'),
      auditLog: hasPermission('audit_log_einsehen'),
      backup: res.locals.isSuperadmin,
      module: res.locals.isSuperadmin,
      kreditkarten: hasPermission('kreditkarten_verwalten'),
      altfaelle: hasPermission('workflow_eingreifen'),
      betrieb: hasPermission('betrieb_einsehen'),
    };
    // Strip a trailing slash (e.g. "/pool/") so nav highlighting/buttons keyed on an exact
    // path like "/pool" still match — Express routes both with and without it identically.
    res.locals.currentPath = req.path.length > 1 ? req.path.replace(/\/+$/, '') : req.path;
    res.locals.kreditkartenModulAktiv = getConfigValue(db, 'modul_kreditkarten_aktiv') === '1';
    res.locals.zeigeKreditkarteNav = Boolean(person) && res.locals.kreditkartenModulAktiv && zeigeKreditkartenBereich(db, person.churchtools_person_id);
    res.locals.banner = person ? aktiveBanner(db, person.churchtools_person_id) : [];
    if (person) {
      const bereich = bereichFuerPfad(res.locals.currentPath);
      const zeigeAdminReiter = Boolean(res.locals.isSuperadmin || res.locals.isManager || Object.values(res.locals.adminNav).some(Boolean));
      const gruppen =
        bereich === 'admin'
          ? baueAdminGruppen({ pfad: res.locals.currentPath, adminNav: res.locals.adminNav })
          : bauePortalGruppen({
              pfad: res.locals.currentPath,
              spesenModulAktiv: res.locals.spesenModulAktiv !== false,
              zeigeKreditkarteNav: res.locals.zeigeKreditkarteNav,
              offeneAufgaben: zaehleOffeneAufgaben(db, person.churchtools_person_id, { istSuperadmin: res.locals.isSuperadmin }),
            });
      res.locals.navigation = { bereich, zeigeAdminReiter, gruppen };
    } else {
      res.locals.navigation = null;
    }
    next();
  };
}
