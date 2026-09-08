import { Router } from 'express';
import { setFerienmodus, clearFerienmodus } from '../db/personenRepo.js';
import { listVertretungsKandidaten } from '../db/kontenRepo.js';
import { personName } from '../services/auditLog.js';

const DATUM_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// Same UTC-date-string comparison approach src/services/vertretung.js already uses for
// "aktiv" -- lexicographic comparison against YYYY-MM-DD, never a separate stored flag. Returns
// null when no Ferienmodus is set at all (the "keiner" case from the design spec), otherwise one
// of 'geplant' (starts in the future), 'aktiv' (today falls within the period) or 'abgelaufen'
// (the period is already over but the record hasn't been cleared yet).
function berechneStatus(person) {
  if (!person.ferienmodus_von) return null;
  const heute = new Date().toISOString().slice(0, 10);
  if (heute < person.ferienmodus_von) return 'geplant';
  if (heute > person.ferienmodus_bis) return 'abgelaufen';
  return 'aktiv';
}

// Resolves the Stellvertreter's display name via personName (falls back to "Unbekannt" for an
// unresolvable id) rather than looking it up in the `kandidaten` array -- a person who has since
// been deactivated or lost the shared-Konto role that made them a candidate drops out of
// `kandidaten`, which would otherwise silently render a blank name while they still hold real
// elevated access.
function stellvertreterNameFuer(db, person) {
  return person.ferienmodus_stellvertreter_id ? personName(db, person.ferienmodus_stellvertreter_id) : null;
}

export function createFerienmodusRouter({ db, csrfProtection = (req, res, next) => next() }) {
  const router = Router();

  router.get('/', (req, res) => {
    const person = req.currentPerson;
    res.render('ferienmodus', {
      person,
      status: berechneStatus(person),
      stellvertreterName: stellvertreterNameFuer(db, person),
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
        status: berechneStatus(person),
        stellvertreterName: stellvertreterNameFuer(db, person),
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
