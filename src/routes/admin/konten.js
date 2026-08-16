import { Router } from 'express';
import { createKonto, updateKonto, deactivateKonto, getKontoById, listKonten, validateKontoRoles } from '../../db/kontenRepo.js';
import { listActivePersons, getPersonById } from '../../db/personenRepo.js';

function personDisplayName(db, id) {
  const person = getPersonById(db, id);
  return person ? `${person.vorname} ${person.nachname}` : String(id);
}

function readRoleFields(body) {
  return {
    kontonummer: body.kontonummer,
    bezeichnung: body.bezeichnung,
    freigeber1Id: body.freigeber1Id,
    stellvertreter1Id: body.stellvertreter1Id,
    freigeber2Id: body.freigeber2Id,
    stellvertreter2Id: body.stellvertreter2Id,
  };
}

export function createKontenRouter({ db }) {
  const router = Router();

  router.get('/', (req, res) => {
    const zeigtAlle = req.query.alle === '1';
    const konten = listKonten(db, { includeInactive: zeigtAlle }).map((konto) => ({
      ...konto,
      freigeber1Name: personDisplayName(db, konto.freigeber1_id),
      freigeber2Name: personDisplayName(db, konto.freigeber2_id),
    }));
    res.render('admin/konten-liste', { konten, zeigtAlle });
  });

  router.get('/neu', (req, res) => {
    res.render('admin/konten-form', { konto: null, values: {}, errors: [], personen: listActivePersons(db) });
  });

  router.post('/', (req, res) => {
    const values = readRoleFields(req.body);
    const errors = validateKontoRoles(db, values);
    if (!values.kontonummer) errors.push('Kontonummer ist ein Pflichtfeld.');
    if (!values.bezeichnung) errors.push('Bezeichnung ist ein Pflichtfeld.');

    if (errors.length > 0) {
      return res.status(400).render('admin/konten-form', { konto: null, values, errors, personen: listActivePersons(db) });
    }

    createKonto(db, values);
    res.redirect('/admin/konten');
  });

  router.get('/:id/bearbeiten', (req, res) => {
    const konto = getKontoById(db, Number(req.params.id));
    if (!konto) {
      return res.status(404).render('error', { message: 'Konto nicht gefunden.' });
    }
    res.render('admin/konten-form', {
      konto,
      values: {
        kontonummer: konto.kontonummer,
        bezeichnung: konto.bezeichnung,
        freigeber1Id: konto.freigeber1_id,
        stellvertreter1Id: konto.stellvertreter1_id,
        freigeber2Id: konto.freigeber2_id,
        stellvertreter2Id: konto.stellvertreter2_id,
      },
      errors: [],
      personen: listActivePersons(db),
    });
  });

  router.post('/:id', (req, res) => {
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
    if (!values.kontonummer) errors.push('Kontonummer ist ein Pflichtfeld.');
    if (!values.bezeichnung) errors.push('Bezeichnung ist ein Pflichtfeld.');

    if (errors.length > 0) {
      return res.status(400).render('admin/konten-form', { konto, values, errors, personen: listActivePersons(db) });
    }

    updateKonto(db, id, values);
    res.redirect('/admin/konten');
  });

  router.post('/:id/deaktivieren', (req, res) => {
    deactivateKonto(db, Number(req.params.id));
    res.redirect('/admin/konten');
  });

  return router;
}
