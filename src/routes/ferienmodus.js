import { Router } from 'express';
import { setFerienmodus, clearFerienmodus } from '../db/personenRepo.js';
import { listVertretungsKandidaten } from '../db/kontenRepo.js';

const DATUM_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function createFerienmodusRouter({ db, csrfProtection = (req, res, next) => next() }) {
  const router = Router();

  router.get('/', (req, res) => {
    const person = req.currentPerson;
    res.render('ferienmodus', {
      person,
      kandidaten: listVertretungsKandidaten(db, person.churchtools_person_id),
      values: {
        von: person.ferienmodus_von || '',
        bis: person.ferienmodus_bis || '',
        stellvertreterId: person.ferienmodus_stellvertreter_id || '',
      },
      errors: [],
    });
  });

  router.post('/', csrfProtection, (req, res) => {
    const person = req.currentPerson;
    const kandidaten = listVertretungsKandidaten(db, person.churchtools_person_id);
    const { von, bis, stellvertreterId, aktion } = req.body;

    if (aktion === 'beenden') {
      clearFerienmodus(db, person.churchtools_person_id);
      return res.redirect('/ferienmodus');
    }

    const errors = [];
    if (!von || !DATUM_PATTERN.test(von) || Number.isNaN(new Date(von).getTime())) {
      errors.push('Bitte ein gültiges Von-Datum angeben.');
    }
    if (!bis || !DATUM_PATTERN.test(bis) || Number.isNaN(new Date(bis).getTime())) {
      errors.push('Bitte ein gültiges Bis-Datum angeben.');
    }
    if (errors.length === 0 && bis < von) {
      errors.push('Das Bis-Datum darf nicht vor dem Von-Datum liegen.');
    }
    const stellvertreter = kandidaten.find((k) => k.churchtools_person_id === stellvertreterId);
    if (!stellvertreter) {
      errors.push('Bitte einen gültigen Stellvertreter aus der Liste auswählen.');
    }

    if (errors.length > 0) {
      return res.status(400).render('ferienmodus', {
        person,
        kandidaten,
        values: { von: von || '', bis: bis || '', stellvertreterId: stellvertreterId || '' },
        errors,
      });
    }

    setFerienmodus(db, person.churchtools_person_id, { von, bis, stellvertreterId });
    res.redirect('/ferienmodus');
  });

  return router;
}
