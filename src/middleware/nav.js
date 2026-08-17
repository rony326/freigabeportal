import { personHasRole } from './roles.js';

export function loadNavFlags(config) {
  return (req, res, next) => {
    res.locals.isBuchhaltung = personHasRole(req.currentPerson, config, 'buchhaltung');
    res.locals.isPortalAdmin = personHasRole(req.currentPerson, config, 'portal-admin');
    res.locals.currentPath = req.path;
    next();
  };
}
