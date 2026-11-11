import { Router } from 'express';
import { istWartungsmodusAktiv, wartungsHinweis, setzeWartungsmodus } from '../../services/wartungsmodus.js';

export function createWartungsmodusRouter({ db, csrfProtection = (req, res, next) => next() }) {
  const router = Router();

  router.get('/', (req, res) => {
    res.render('admin/wartungsmodus', {
      aktiv: istWartungsmodusAktiv(db),
      hinweis: wartungsHinweis(db),
      gespeichert: req.query.gespeichert === '1',
    });
  });

  router.post('/', csrfProtection, (req, res) => {
    const aktion = req.body.aktion;
    if (aktion !== 'einschalten' && aktion !== 'ausschalten') {
      return res.status(400).render('error', { message: 'Ungültige Aktion. Bitte den Wartungsmodus über die Schaltfläche ein- oder ausschalten.' });
    }
    setzeWartungsmodus(db, aktion === 'einschalten', req.body.hinweis);
    res.redirect('/admin/wartungsmodus?gespeichert=1');
  });

  return router;
}
