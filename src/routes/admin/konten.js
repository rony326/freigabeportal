// Admin → Konten (`/admin/konten`, Recht `konten_verwalten`, docs/admin-bereich.md): Konten mit Kontonummer, Bezeichnung, den vier Freigabe-Rollen (Freigeber 1/2 und Stellvertretungen, vier verschiedene aktive Personen) und der Buchungsart anlegen, ändern, (de)aktivieren.

import { Router } from 'express';
import { BUCHUNGSARTEN, BUCHUNGSART_LABEL, createKonto, updateKonto, deactivateKonto, activateKonto, getKontoById, listKonten, validateKontoRoles } from '../../db/kontenRepo.js';
import { listActivePersons, getPersonById } from '../../db/personenRepo.js';

// Anzeigename einer Person oder 'Unbekannt'.
function personDisplayName(db, id) {
  const person = getPersonById(db, id);
  return person ? `${person.vorname} ${person.nachname}` : String(id);
}

// Liest die vier Rollenfelder aus dem Formular.
function readRoleFields(body) {
  return {
    kontonummer: body.kontonummer,
    bezeichnung: body.bezeichnung,
    freigeber1Id: body.freigeber1Id,
    stellvertreter1Id: body.stellvertreter1Id,
    freigeber2Id: body.freigeber2Id,
    stellvertreter2Id: body.stellvertreter2Id,
    buchungsart: body.buchungsart,
  };
}

// Fehlt die Buchungsart im Formular, bleibt sie beim Bearbeiten unverändert und ist beim Anlegen 'beides'.
function pruefeBuchungsart(values, errors) {
  if (values.buchungsart === undefined || values.buchungsart === '') {
    values.buchungsart = undefined;
    return;
  }
  if (!BUCHUNGSARTEN.includes(values.buchungsart)) errors.push('Buchungsart: bitte Rechnung, Gutschrift oder Rechnung / Gutschrift wählen.');
}

export function createKontenRouter({ db, csrfProtection = (req, res, next) => next() }) {
  const router = Router();

  // GET /admin/konten – Liste (aktive und inaktive).
  router.get('/', (req, res) => {
    const zeigtAlle = req.query.alle === '1';
    const konten = listKonten(db, { includeInactive: zeigtAlle }).map((konto) => ({
      ...konto,
      freigeber1Name: personDisplayName(db, konto.freigeber1_id),
      freigeber2Name: personDisplayName(db, konto.freigeber2_id),
    }));
    res.render('admin/konten-liste', { BUCHUNGSART_LABEL, konten, zeigtAlle, gespeichert: req.query.gespeichert === '1' });
  });

  // GET /admin/konten/neu – Formular.
  router.get('/neu', (req, res) => {
    res.render('admin/konten-form', { BUCHUNGSARTEN, BUCHUNGSART_LABEL, konto: null, values: {}, errors: [], personen: listActivePersons(db) });
  });

  // POST /admin/konten – legt ein Konto an (Validierung der Rollenbesetzung: validateKontoRoles).
  router.post('/', csrfProtection, (req, res) => {
    const values = readRoleFields(req.body);
    const errors = validateKontoRoles(db, values);
    pruefeBuchungsart(values, errors);
    if (!values.kontonummer) errors.push('Kontonummer ist ein Pflichtfeld.');
    if (!values.bezeichnung) errors.push('Bezeichnung ist ein Pflichtfeld.');

    if (errors.length > 0) {
      return res.status(400).render('admin/konten-form', { BUCHUNGSARTEN, BUCHUNGSART_LABEL, konto: null, values, errors, personen: listActivePersons(db) });
    }

    createKonto(db, values);
    res.redirect('/admin/konten?gespeichert=1');
  });

  // GET /admin/konten/:id/bearbeiten – Bearbeitungsformular.
  router.get('/:id/bearbeiten', (req, res) => {
    const konto = getKontoById(db, Number(req.params.id));
    if (!konto) {
      return res.status(404).render('error', { message: 'Konto nicht gefunden.' });
    }
    res.render('admin/konten-form', { BUCHUNGSARTEN, BUCHUNGSART_LABEL,
      konto,
      values: {
        kontonummer: konto.kontonummer,
        bezeichnung: konto.bezeichnung,
        freigeber1Id: konto.freigeber1_id,
        stellvertreter1Id: konto.stellvertreter1_id,
        freigeber2Id: konto.freigeber2_id,
        stellvertreter2Id: konto.stellvertreter2_id,
        buchungsart: konto.buchungsart,
      },
      errors: [],
      personen: listActivePersons(db),
    });
  });

  // POST /admin/konten/:id – speichert Änderungen.
  router.post('/:id', csrfProtection, (req, res) => {
    const id = Number(req.params.id);
    const konto = getKontoById(db, id);
    if (!konto) {
      return res.status(404).render('error', { message: 'Konto nicht gefunden.' });
    }

    const values = readRoleFields(req.body);
    const existingRoles = {
      freigeber1Id: konto.freigeber1_id,
      stellvertreter1Id: konto.stellvertreter1_id,
      freigeber2Id: konto.freigeber2_id,
      stellvertreter2Id: konto.stellvertreter2_id,
    };
    const errors = validateKontoRoles(db, values, existingRoles);
    pruefeBuchungsart(values, errors);
    if (!values.kontonummer) errors.push('Kontonummer ist ein Pflichtfeld.');
    if (!values.bezeichnung) errors.push('Bezeichnung ist ein Pflichtfeld.');

    if (errors.length > 0) {
      return res.status(400).render('admin/konten-form', { BUCHUNGSARTEN, BUCHUNGSART_LABEL, konto, values, errors, personen: listActivePersons(db) });
    }

    updateKonto(db, id, values);
    res.redirect('/admin/konten?gespeichert=1');
  });

  // POST /admin/konten/:id/deaktivieren – Konto abschalten (wird nie gelöscht).
  router.post('/:id/deaktivieren', csrfProtection, (req, res) => {
    deactivateKonto(db, Number(req.params.id));
    res.redirect('/admin/konten');
  });

  // POST /admin/konten/:id/aktivieren – Konto wieder einschalten.
  router.post('/:id/aktivieren', csrfProtection, (req, res) => {
    activateKonto(db, Number(req.params.id));
    res.redirect('/admin/konten?alle=1');
  });

  return router;
}
