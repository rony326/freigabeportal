// Admin → Datei-Quarantäne (`/admin/dateiquarantaene`, Recht `dateiquarantaene_verwalten`, docs/audit-paket-haertung-2026-09-29.md): verwaiste finale Dokumente ansehen, Prüfung anstossen, Dateien wiederherstellen oder endgültig löschen.

import { Router } from 'express';
import {
  listQuarantaene, runVerwaisteDateienPruefung, stelleQuarantaeneDateiWiederHer, loescheQuarantaeneDatei, QuarantaeneFehler,
} from '../../services/verwaisteDateien.js';

// Zugang: Recht `dateiquarantaene_verwalten` (Mount in app.js). Jede Entscheidung verlangt CSRF und eine Begruendung.
export function createDateiQuarantaeneRouter({ db, config, csrfProtection = (req, res, next) => next() }) {
  const router = Router();

  // GET /admin/dateiquarantaene – Liste der Quarantäne-Einträge.
  router.get('/', (req, res) => {
    res.render('admin/datei-quarantaene', {
      eintraege: listQuarantaene(db),
      ergebnis: req.query.ergebnis || null,
    });
  });

  // POST /admin/dateiquarantaene/pruefen – startet die Prüfung auf verwaiste Dateien sofort.
  router.post('/pruefen', csrfProtection, (req, res) => {
    const ergebnis = runVerwaisteDateienPruefung(db, config);
    res.redirect(`/admin/dateiquarantaene?ergebnis=${encodeURIComponent(ergebnis.status)}`);
  });

  // Baut den Handler für "wiederherstellen" bzw. "löschen" (Begründung Pflicht).
  function entscheidung(aktion) {
    return (req, res, next) => {
      try {
        aktion(db, config, Number(req.params.id), req.body?.begruendung);
        res.redirect('/admin/dateiquarantaene');
      } catch (err) {
        if (err instanceof QuarantaeneFehler) return res.status(err.status).render('error', { message: err.message });
        next(err);
      }
    };
  }

  router.post('/:id/wiederherstellen', csrfProtection, entscheidung(stelleQuarantaeneDateiWiederHer));
  router.post('/:id/loeschen', csrfProtection, entscheidung(loescheQuarantaeneDatei));

  return router;
}
