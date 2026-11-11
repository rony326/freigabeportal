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
    const einschalten = req.body.aktion === 'einschalten';
    setzeWartungsmodus(db, einschalten, req.body.hinweis);
    res.redirect('/admin/wartungsmodus?gespeichert=1');
  });

  return router;
}
