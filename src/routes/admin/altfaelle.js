// (Admin → Altfälle, `/admin/altfaelle`, Recht `workflow_eingreifen`; Fachliches: docs/export-und-zahlungsintegritaet.md.)

import { Router } from 'express';
import { getAltfall, listAltfaelle, altfallAnzeige, altfallStand, entscheideAltfall, AltfallError } from '../../services/altfaelle.js';
import { pruefeUndFinalisiereSplitGruppe } from '../../services/splitGruppenExport.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';

// Admin -> Altfaelle: abgeschlossene Belege/Splitgruppen ohne belastbaren Freigabe- oder
// Zahlungsnachweis. Export bleibt gesperrt, bis hier ausdruecklich entschieden wurde.
export function createAltfaelleRouter({ db, config, csrfProtection = (req, res, next) => next() }) {
  const router = Router();
  router.param('id', (req, res, next, value) => {
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) return res.status(404).render('error', { message: 'Altfall nicht gefunden.' });
    next();
  });

  // GET /admin/altfaelle – Liste der offenen Altfälle.
  router.get('/', (req, res) => {
    res.render('admin/altfaelle-liste', { altfaelle: listAltfaelle(db), gespeichert: req.query.gespeichert === '1' });
  });

  // Rendert die Entscheidungsseite mit dem Stand, der der Person gezeigt wird (inkl. Prüfsumme `stand`).
  async function renderAltfall(req, res, status, altfall, { errors = [], values = {} } = {}) {
    const anzeige = await altfallAnzeige(db, config, altfall);
    res.status(status).render('admin/altfall-entscheiden', {
      anzeige,
      stand: altfallStand(anzeige.job.id, anzeige.daten, req.currentPerson.churchtools_person_id),
      errors,
      values,
    });
  }

  // GET /admin/altfaelle/:id – zeigt den Altfall mit Herkunft jedes Werts.
  router.get('/:id', asyncHandler(async (req, res, next) => {
    try {
      const altfall = getAltfall(db, Number(req.params.id));
      if (!altfall) return res.status(404).render('error', { message: 'Kein offener Altfall mit dieser Nummer.' });
      await renderAltfall(req, res, 200, altfall);
    } catch (err) {
      next(err);
    }
  }));

  // POST /admin/altfaelle/:id – speichert die Entscheidung ('nachbestaetigt' | 'nur_archiv', Begründung Pflicht) und finalisiert bei einer Splitgruppe das Gruppendokument.
  router.post('/:id', csrfProtection, asyncHandler(async (req, res, next) => {
    try {
      const altfall = getAltfall(db, Number(req.params.id));
      if (!altfall) return res.status(409).render('error', { message: 'Dieser Fall ist nicht mehr offen.' });
      const { entscheidung, begruendung, stand, bestaetigung } = req.body;
      const values = { entscheidung, begruendung };
      if (bestaetigung !== 'ja') {
        return renderAltfall(req, res, 400, altfall, { errors: ['Bitte bestätigen, dass die angezeigten Daten geprüft wurden.'], values });
      }
      const anzeige = await altfallAnzeige(db, config, altfall);
      try {
        entscheideAltfall(db, { anzeige, entscheidung, stand, begruendung, person: req.currentPerson });
      } catch (err) {
        if (!(err instanceof AltfallError)) throw err;
        if (err.status === 403) return res.status(403).render('error', { message: err.message });
        const noch = getAltfall(db, altfall.job.id);
        if (!noch) return res.status(409).render('error', { message: err.message });
        return renderAltfall(req, res, err.status, noch, { errors: [err.message], values });
      }
      if (altfall.gruppe && !altfall.job.gruppe_pdf_pfad) {
        try {
          await pruefeUndFinalisiereSplitGruppe(db, altfall.job.id, config);
        } catch (err) {
          // Der Cron-Job split-gruppen-nachholen wiederholt einen fehlgeschlagenen Merge.
          console.error(`Splitgruppen-Finalisierung nach Altfall-Entscheidung für ${altfall.job.id} fehlgeschlagen:`, err.message);
        }
      }
      res.redirect('/admin/altfaelle?gespeichert=1');
    } catch (err) {
      next(err);
    }
  }));

  return router;
}
