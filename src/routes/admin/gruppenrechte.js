// Admin → Gruppenrechte (`/admin/gruppenrechte`, festes Recht nur für Superadmin, docs/auth-und-rechte.md): Matrix, welche Admin-Rechte die ChurchTools-Gruppen Superadmin, Manager und Buchhaltung haben. Änderungen werden im Audit festgehalten (services/rechteAudit.js).

import { Router } from 'express';
import { GRUPPEN, FESTE_RECHTE, BERECHTIGUNG_BEREICHE, BERECHTIGUNG_LABELS, GRANTABLE_BERECHTIGUNGEN } from '../../services/berechtigungKatalog.js';
import { listAlleGruppenBerechtigungen, setGruppenBerechtigungen } from '../../db/gruppenBerechtigungenRepo.js';
import { auditiereGruppenrechte } from '../../services/rechteAudit.js';

const GRUPPEN_LABEL = { superadmin: 'Superadmin', manager: 'Manager', buchhaltung: 'Buchhaltung' };

export function createGruppenrechteRouter({ db, config, csrfProtection = (req, res, next) => next() }) {
  const router = Router();

  // GET /admin/gruppenrechte – die Matrix (nach Bereichen gruppiert).
  router.get('/', (req, res) => {
    res.render('admin/gruppenrechte', {
      gruppen: GRUPPEN,
      gruppenLabel: GRUPPEN_LABEL,
      bereiche: BERECHTIGUNG_BEREICHE,
      labels: BERECHTIGUNG_LABELS,
      festeRechte: FESTE_RECHTE,
      rechte: listAlleGruppenBerechtigungen(db),
      gespeichert: req.query.gespeichert === '1',
    });
  });

  // POST /admin/gruppenrechte – speichert die Rechte aller Gruppen (nur vergebbare Rechte; Superadmin behält das feste Recht).
  router.post('/', csrfProtection, (req, res, next) => {
    const vorher = listAlleGruppenBerechtigungen(db);
    // Rechte und Audit in einer Transaktion: scheitert das Audit, wird auch die Änderung zurückgenommen.
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const gruppe of GRUPPEN) {
        const angefordert = [].concat(req.body[`recht_${gruppe}`] || []).map(String);
        // Feste Rechte kommen nie aus dem Formular; setGruppenBerechtigungen erzwingt sie bei superadmin.
        const gueltig = angefordert.filter((recht) => GRANTABLE_BERECHTIGUNGEN.includes(recht));
        setGruppenBerechtigungen(db, gruppe, gueltig);
        const nachher = listAlleGruppenBerechtigungen(db)[gruppe];
        auditiereGruppenrechte(db, gruppe, vorher[gruppe], nachher);
      }
      db.exec('COMMIT');
    } catch (err) {
      if (db.isTransaction) db.exec('ROLLBACK');
      return next(err);
    }
    res.redirect('/admin/gruppenrechte?gespeichert=1');
  });

  return router;
}
