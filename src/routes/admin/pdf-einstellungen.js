import { Router } from 'express';
import { getConfigValue, setConfigValue } from '../../db/adminConfigRepo.js';

const VALID_POSITIONEN = new Set(['erste', 'letzte']);

export function createPdfEinstellungenRouter({ db }) {
  const router = Router();

  router.get('/', (req, res) => {
    res.render('admin/pdf-einstellungen-form', {
      visumSeitePosition: getConfigValue(db, 'visum_seite_position'),
      errors: [],
      gespeichert: req.query.gespeichert === '1',
    });
  });

  router.post('/', (req, res) => {
    const { visumSeitePosition } = req.body;

    if (!VALID_POSITIONEN.has(visumSeitePosition)) {
      return res.status(400).render('admin/pdf-einstellungen-form', {
        visumSeitePosition,
        errors: ['Position der Visum-Seite muss "erste" oder "letzte" sein.'],
        gespeichert: false,
      });
    }

    setConfigValue(db, 'visum_seite_position', visumSeitePosition);
    res.redirect('/admin/pdf-einstellungen?gespeichert=1');
  });

  return router;
}
