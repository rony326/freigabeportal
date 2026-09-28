import { Router } from 'express';
import { getAltfall, listAltfaelle, altfallAnzeige, altfallStand, entscheideAltfall, AltfallError } from '../../services/altfaelle.js';
import { pruefeUndFinalisiereSplitGruppe } from '../../services/splitGruppenExport.js';

// Admin -> Altfaelle: abgeschlossene Belege/Splitgruppen ohne belastbaren Freigabe- oder
// Zahlungsnachweis. Export bleibt gesperrt, bis hier ausdruecklich entschieden wurde.
export function createAltfaelleRouter({ db, config, csrfProtection = (req, res, next) => next() }) {
  const router = Router();
  router.param('id', (req, res, next, value) => {
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) return res.status(404).render('error', { message: 'Altfall nicht gefunden.' });
    next();
  });

  router.get('/', (req, res) => {
    res.render('admin/altfaelle-liste', { altfaelle: listAltfaelle(db), gespeichert: req.query.gespeichert === '1' });
  });

  async function renderAltfall(req, res, status, altfall, { errors = [], values = {} } = {}) {
    const anzeige = await altfallAnzeige(db, config, altfall);
    res.status(status).render('admin/altfall-entscheiden', {
      anzeige,
      stand: altfallStand(anzeige.job.id, anzeige.daten, req.currentPerson.churchtools_person_id),
      errors,
      values,
    });
  }

  router.get('/:id', async (req, res, next) => {
    try {
      const altfall = getAltfall(db, Number(req.params.id));
      if (!altfall) return res.status(404).render('error', { message: 'Kein offener Altfall mit dieser Nummer.' });
      await renderAltfall(req, res, 200, altfall);
    } catch (err) {
      next(err);
    }
  });

  router.post('/:id', csrfProtection, async (req, res, next) => {
    try {
      const altfall = getAltfall(db, Number(req.params.id));
      if (!altfall) return res.status(409).render('error', { message: 'Dieser Fall ist nicht mehr offen.' });
      const { entscheidung, begruendung, stand, bestaetigung } = req.body;
      const values = { entscheidung, begruendung };
      if (bestaetigung !== 'ja') {
        return renderAltfall(req, res, 400, altfall, { errors: ['Bitte bestaetigen, dass die angezeigten Daten geprueft wurden.'], values });
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
          // The split-gruppen-nachholen cron job retries a failed merge.
          console.error(`Splitgruppen-Finalisierung nach Altfall-Entscheidung fuer ${altfall.job.id} fehlgeschlagen:`, err.message);
        }
      }
      res.redirect('/admin/altfaelle?gespeichert=1');
    } catch (err) {
      next(err);
    }
  });

  return router;
}
