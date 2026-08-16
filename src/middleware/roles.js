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
  'portal-admin': 'groupIdAdmin',
};

export function requireRole(config, role) {
  return (req, res, next) => {
    const groupId = config.churchtools[GROUP_ID_KEY_BY_ROLE[role]];
    const person = req.currentPerson;

    if (!person || !person.aktiv) {
      return res.status(401).render('error', { message: 'Bitte melde dich an, um fortzufahren.' });
    }
    if (!person.gruppen.includes(String(groupId))) {
      return res.status(403).render('error', { message: 'Du hast keine Berechtigung für diesen Bereich.' });
    }
    next();
  };
}
