import { Router } from 'express';
import { listAllPersons, getPersonById } from '../../db/personenRepo.js';
import { personHasRole, requireRole } from '../../middleware/roles.js';
import { listBerechtigungenForPerson, setBerechtigungenForPerson } from '../../db/personBerechtigungenRepo.js';
import { GRANTABLE_BERECHTIGUNGEN, BERECHTIGUNG_LABELS } from '../../middleware/permissions.js';

function rolleVon(person, config) {
  if (personHasRole(person, config, 'superadmin')) return 'Superadmin';
  if (personHasRole(person, config, 'manager')) return 'Manager';
  return 'Benutzer';
}

export function createPersonenRouter({ db, config }) {
  const router = Router();

  router.get('/', (req, res) => {
    const bearbeitbar = personHasRole(req.currentPerson, config, 'superadmin');
    const personen = listAllPersons(db).map((p) => ({
      ...p,
      rolle: rolleVon(p, config),
      berechtigungen: listBerechtigungenForPerson(db, p.churchtools_person_id),
    }));
    res.render('admin/personen-liste', {
      personen,
      bearbeitbar,
      grantableBerechtigungen: GRANTABLE_BERECHTIGUNGEN,
      berechtigungLabels: BERECHTIGUNG_LABELS,
    });
  });

  router.post('/:id/berechtigungen', requireRole(config, 'superadmin'), (req, res) => {
    if (!getPersonById(db, req.params.id)) {
      return res.status(404).render('error', { message: 'Person nicht gefunden.' });
    }
    const angefordert = [].concat(req.body.berechtigungen || []);
    const gueltig = angefordert.filter((b) => GRANTABLE_BERECHTIGUNGEN.includes(b));
    setBerechtigungenForPerson(db, req.params.id, gueltig);
    res.redirect('/admin/personen');
  });

  return router;
}
