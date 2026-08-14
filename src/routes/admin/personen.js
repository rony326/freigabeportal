import { Router } from 'express';
import { listAllPersons } from '../../db/personenRepo.js';

export function createPersonenRouter({ db }) {
  const router = Router();

  router.get('/', (req, res) => {
    res.render('admin/personen-liste', { personen: listAllPersons(db) });
  });

  return router;
}
