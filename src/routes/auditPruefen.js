import { Router } from 'express';
import { getConfigValue } from '../db/adminConfigRepo.js';
import { normalisierePruefnummer, pruefeAuditNachweis } from '../services/auditPruefung.js';
import { formatierePruefnummer } from '../services/auditNachweisJobs.js';

// Oeffentlich (ohne Login) fuer die Revision; nur GET, daher kein CSRF-Token noetig.
export function createAuditPruefenRouter({ db }) {
  const router = Router();

  router.get('/', async (req, res, next) => {
    try {
      const abgeschaltet = getConfigValue(db, 'modul_audit_nachweis_aktiv') !== '1';
      const rohPaket = typeof req.query.paket === 'string' ? req.query.paket : '';
      const rohNummer = typeof req.query.pruefnummer === 'string' ? req.query.pruefnummer : '';
      const basis = { abgeschaltet, eingabe: { paket: rohPaket, pruefnummer: rohNummer }, errors: [], ergebnis: null };
      if (!('paket' in req.query) && !('pruefnummer' in req.query)) return res.render('audit-pruefen', basis);

      const errors = [];
      const paketNr = /^\d{1,15}$/.test(rohPaket.trim()) ? Number(rohPaket.trim()) : 0;
      if (!paketNr) errors.push('Bitte eine gültige Paketnummer eingeben (ganze Zahl ab 1).');
      const pruefnummer = normalisierePruefnummer(rohNummer);
      if (!pruefnummer) errors.push('Bitte eine gültige Prüfnummer eingeben (64 Zeichen 0–9 und a–f, Leerzeichen sind erlaubt).');
      if (errors.length) return res.status(400).render('audit-pruefen', { ...basis, errors });

      const ergebnis = await pruefeAuditNachweis(db, { paketNr, pruefnummer });
      res.render('audit-pruefen', {
        ...basis,
        ergebnis: { ...ergebnis, paketNr, pruefnummer: formatierePruefnummer(pruefnummer), geprueftAm: new Date() },
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
