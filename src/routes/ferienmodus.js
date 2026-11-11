// Seite "Ferienmodus" (`/ferienmodus`, docs/superpowers/specs/2026-09-07-ferienmodus-design.md): eine Person trägt Abwesenheit (von/bis) und eine Stellvertretung ein; für die Dauer
// gelten Mails und Berechtigungen zusätzlich für die Stellvertretung (services/vertretung.js). Zugang: angemeldet.

import { Router } from 'express';
import { setFerienmodus, clearFerienmodus } from '../db/personenRepo.js';
import { listVertretungsKandidaten } from '../db/kontenRepo.js';
import { personName } from '../services/auditLog.js';

const DATUM_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// Gleiches Vorgehen beim Vergleich von UTC-Datumstexten wie in src/services/vertretung.js für "aktiv" — lexikografischer Vergleich mit YYYY-MM-DD, nie ein eigenes gespeichertes Flag.
// Liefert null, wenn gar kein Ferienmodus gesetzt ist (der Fall "keiner" aus der Entwurfsbeschreibung), sonst 'geplant' (beginnt in der Zukunft), 'aktiv' (heute liegt im Zeitraum) oder 'abgelaufen' (der Zeitraum
// ist vorbei, der Eintrag aber noch nicht gelöscht).
function berechneStatus(person) {
  if (!person.ferienmodus_von) return null;
  const heute = new Date().toISOString().slice(0, 10);
  if (heute < person.ferienmodus_von) return 'geplant';
  if (heute > person.ferienmodus_bis) return 'abgelaufen';
  return 'aktiv';
}

// Löst den Anzeigenamen der Stellvertretung über personName auf (fällt bei einer nicht auflösbaren id auf "Unbekannt" zurück), statt ihn im Array `kandidaten` nachzuschlagen — eine Person, die inzwischen
// deaktiviert wurde oder die gemeinsame Konto-Rolle verlor, die sie zur Kandidatin machte, fällt aus `kandidaten` heraus, was sonst still einen leeren Namen rendern würde, während sie noch echte erweiterte Zugriffe hat.
function stellvertreterNameFuer(db, person) {
  return person.ferienmodus_stellvertreter_id ? personName(db, person.ferienmodus_stellvertreter_id) : null;
}

export function createFerienmodusRouter({ db, csrfProtection = (req, res, next) => next() }) {
  const router = Router();

  // GET /ferienmodus – Formular mit aktuellem Stand (geplant / aktiv / abgelaufen) und Kandidaten.
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

  // POST /ferienmodus – speichert Zeitraum und Stellvertretung (Validierung) oder beendet den Ferienmodus (`aktion=beenden`).
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
