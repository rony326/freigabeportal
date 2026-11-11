// Admin → Wartungsmodus (`/admin/wartungsmodus`, Recht `wartungsmodus_schalten`, docs/admin-bereich.md): Portal für normale Nutzer sperren (Hinweistext), z. B. für eine saubere Sicherung. Wirkung: middleware/wartungsmodus.js.

import { Router } from 'express';
import { istWartungsmodusAktiv, wartungsHinweis, setzeWartungsmodus } from '../../services/wartungsmodus.js';

export function createWartungsmodusRouter({ db, csrfProtection = (req, res, next) => next() }) {
  const router = Router();

  // GET /admin/wartungsmodus – Zustand und Formular.
  router.get('/', (req, res) => {
    res.render('admin/wartungsmodus', {
      aktiv: istWartungsmodusAktiv(db),
      hinweis: wartungsHinweis(db),
      gespeichert: req.query.gespeichert === '1',
    });
  });

  // POST /admin/wartungsmodus – ein-/ausschalten (mit Hinweistext).
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
