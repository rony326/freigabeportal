import { personHasRole } from './roles.js';
import { erstellePermissionPruefer } from './permissions.js';
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
    const hasPermission = erstellePermissionPruefer(db, config, person);
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
      ersteinrichtung: res.locals.isSuperadmin,
      kreditkarten: hasPermission('kreditkarten_verwalten'),
      budgets: hasPermission('budgets_verwalten'),
      altfaelle: hasPermission('workflow_eingreifen'),
      betrieb: hasPermission('betrieb_einsehen'),
      testmodus: res.locals.isSuperadmin || res.locals.isManager,
    };
    // Strip a trailing slash (e.g. "/pool/") so nav highlighting/buttons keyed on an exact
    // path like "/pool" still match — Express routes both with and without it identically.
    res.locals.currentPath = req.path.length > 1 ? req.path.replace(/\/+$/, '') : req.path;
    // Banner und Navigation (inkl. Aufgabenzähler) braucht nur eine gerenderte Seite. Als Getter
    // berechnet, erst wenn res.render sie liest -- Downloads, JSON und Weiterleitungen sparen sich
    // die Abfragen. Ergebnis je Anfrage gemerkt.
    lazyLocal(res, 'kreditkartenModulAktiv', () => getConfigValue(db, 'modul_kreditkarten_aktiv') === '1', false);
    lazyLocal(res, 'zeigeKreditkarteNav', () => Boolean(person) && res.locals.kreditkartenModulAktiv && zeigeKreditkartenBereich(db, person.churchtools_person_id), false);
    lazyLocal(res, 'banner', () => (person ? aktiveBanner(db, person.churchtools_person_id) : []), []);
    lazyLocal(res, 'navigation', () => {
      if (!person) return null;
      const bereich = bereichFuerPfad(res.locals.currentPath);
      const zeigeAdminReiter = Boolean(res.locals.isSuperadmin || res.locals.isManager || Object.values(res.locals.adminNav).some(Boolean));
      const gruppen =
        bereich === 'admin'
          ? baueAdminGruppen({ pfad: res.locals.currentPath, adminNav: res.locals.adminNav })
          : bauePortalGruppen({
              pfad: res.locals.currentPath,
              spesenModulAktiv: res.locals.spesenModulAktiv !== false,
              zeigeKreditkarteNav: res.locals.zeigeKreditkarteNav,
              // /pool lädt dieselben Listen ohnehin und legt die Summe hier ab (routes/poolPage.js).
              offeneAufgaben: res.locals.offeneAufgabenVorab
                ?? zaehleOffeneAufgaben(db, person.churchtools_person_id, { istSuperadmin: res.locals.isSuperadmin }),
            });
      return { bereich, zeigeAdminReiter, gruppen };
    }, null);
    next();
  };
}

// `rueckfall` (optional): Wert, falls das Berechnen scheitert -- so rendert z.B. die Fehlerseite bei
// kaputter Datenbank noch, nur ohne Menü/Banner (vorher lief die Middleware gar nicht erst durch).
function lazyLocal(res, name, berechne, ...rueckfall) {
  let wert;
  let berechnet = false;
  Object.defineProperty(res.locals, name, {
    enumerable: true,
    configurable: true,
    get() {
      if (!berechnet) {
        try {
          wert = berechne();
        } catch (err) {
          if (rueckfall.length === 0) throw err;
          console.error(`${name} konnte nicht berechnet werden:`, err.message);
          wert = rueckfall[0];
        }
        berechnet = true;
      }
      return wert;
    },
    set(neu) { wert = neu; berechnet = true; },
  });
}
