import { Router } from 'express';
import { listKonten } from '../../db/kontenRepo.js';
import { listBudgetsFuerJahr, setzeBudget, entferneBudget } from '../../db/budgetRepo.js';
import { formatChf, parseBetrag, zuerichHeute } from '../../services/auswertung.js';

function jahrAus(text) {
  const jahr = Number(text);
  return Number.isInteger(jahr) && jahr >= 2000 && jahr <= 2100 ? jahr : null;
}

export function createBudgetsRouter({ db, csrfProtection = (req, res, next) => next() }) {
  const router = Router();

  function zeilen(jahr, eingaben = null, fehlerIds = new Set()) {
    const budgets = listBudgetsFuerJahr(db, jahr);
    const vorjahr = listBudgetsFuerJahr(db, jahr - 1);
    const namen = new Map(db.prepare('SELECT churchtools_person_id AS id, vorname, nachname FROM personen').all()
      .map((p) => [p.id, `${p.vorname ?? ''} ${p.nachname ?? ''}`.trim()]));
    return listKonten(db).map((k) => ({
      id: k.id,
      kontonummer: k.kontonummer,
      bezeichnung: k.bezeichnung,
      freigeber1: namen.get(k.freigeber1_id) || '—',
      wert: eingaben ? (eingaben[k.id] ?? '') : (budgets.has(k.id) ? String(budgets.get(k.id)) : ''),
      vorjahr: vorjahr.has(k.id) ? formatChf(vorjahr.get(k.id)) : null,
      fehler: fehlerIds.has(k.id),
    }));
  }

  router.get('/', (req, res) => {
    const jahr = jahrAus(req.query.jahr) ?? Number(zuerichHeute().slice(0, 4));
    res.render('admin/budgets', { jahr, konten: zeilen(jahr), fehler: null, gespeichert: req.query.gespeichert === '1' });
  });

  router.post('/', csrfProtection, (req, res) => {
    const jahr = jahrAus(req.body.jahr);
    if (jahr === null) {
      const heute = Number(zuerichHeute().slice(0, 4));
      return res.status(400).render('admin/budgets', { jahr: heute, konten: zeilen(heute), fehler: 'Ungültiges Jahr.', gespeichert: false });
    }
    const konten = listKonten(db);
    const eingaben = {};
    const aenderungen = [];
    const fehlerIds = new Set();
    for (const k of konten) {
      const roh = req.body[`budget_${k.id}`];
      if (roh === undefined) continue;
      eingaben[k.id] = String(roh);
      if (String(roh).trim() === '') {
        aenderungen.push({ kontoId: k.id, betrag: null });
        continue;
      }
      const betrag = parseBetrag(roh);
      if (betrag === null) fehlerIds.add(k.id);
      else aenderungen.push({ kontoId: k.id, betrag });
    }
    if (fehlerIds.size) {
      return res.status(400).render('admin/budgets', {
        jahr, konten: zeilen(jahr, eingaben, fehlerIds), gespeichert: false,
        fehler: 'Bitte die markierten Beträge korrigieren (z. B. 12000 oder 12\'000.50). Es wurde nichts gespeichert.',
      });
    }
    const personId = req.currentPerson.churchtools_person_id;
    db.exec('BEGIN');
    try {
      for (const { kontoId, betrag } of aenderungen) {
        if (betrag === null) entferneBudget(db, kontoId, jahr);
        else setzeBudget(db, { kontoId, jahr, betrag, personId });
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    res.redirect(`/admin/budgets?jahr=${jahr}&gespeichert=1`);
  });

  return router;
}
