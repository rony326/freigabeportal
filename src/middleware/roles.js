import { getPersonById } from '../db/personenRepo.js';

export function loadCurrentPerson(db) {
  return (req, res, next) => {
    if (!req.session.personId) {
      req.currentPerson = null;
      res.locals.currentPerson = null;
      return next();
    }
    req.currentPerson = getPersonById(db, req.session.personId);
    // Exposed as a template local (mirroring middleware/branding.js's res.locals.branding
    // pattern) so views can render a logout link without every route handler needing to pass
    // it through explicitly.
    res.locals.currentPerson = req.currentPerson;
    next();
  };
}

const GROUP_ID_KEY_BY_ROLE = {
  buchhaltung: 'groupIdBuchhaltung',
  superadmin: 'groupIdAdmin',
  manager: 'groupIdManager',
};

// Shared by requireRole/requireAnyRole (the HTTP gates) and middleware/nav.js's loadNavFlags
// (Phase F's nav-tab visibility computation) — both need the identical "is this person in
// ChurchTools group X" check. Extracted here rather than duplicated a third time.
export function personHasRole(person, config, role) {
  if (!person) return false;
  const groupId = config.churchtools[GROUP_ID_KEY_BY_ROLE[role]];
  // groupIdManager is optional (CT_GROUP_ID_MANAGER is not required in env.js) — without this
  // guard an unconfigured role would compare against the string "null"/"undefined" instead of
  // simply having nobody in it.
  if (!groupId) return false;
  return person.gruppen.includes(String(groupId));
}

export function requireRole(config, role) {
  return (req, res, next) => {
    const person = req.currentPerson;
    if (!person || !person.aktiv) {
      return res.status(401).render('error', { message: 'Bitte melde dich an, um fortzufahren.' });
    }
    if (!personHasRole(person, config, role)) {
      return res.status(403).render('error', { message: 'Du hast keine Berechtigung für diesen Bereich.' });
    }
    next();
  };
}

export function requireAnyRole(config, roles) {
  return (req, res, next) => {
    const person = req.currentPerson;
    if (!person || !person.aktiv) {
      return res.status(401).render('error', { message: 'Bitte melde dich an, um fortzufahren.' });
    }
    if (!roles.some((role) => personHasRole(person, config, role))) {
      return res.status(403).render('error', { message: 'Du hast keine Berechtigung für diesen Bereich.' });
    }
    next();
  };
}

export function requireLogin() {
  return (req, res, next) => {
    const person = req.currentPerson;
    if (!person || !person.aktiv) {
      return res.status(401).render('error', { message: 'Bitte melde dich an, um fortzufahren.' });
    }
    next();
  };
}
