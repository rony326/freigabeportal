import { Router } from 'express';
import {
  createKreditkarte, updateKreditkarte, setKreditkarteAktiv, getKreditkarteById, listKreditkarten, listErfasserIds, setErfasser,
} from '../../db/kreditkartenRepo.js';
import { listActivePersons, getPersonById } from '../../db/personenRepo.js';
import { isValidAbsenderMuster, ABSENDER_MUSTER_FEHLER } from '../../utils/absenderMuster.js';

const ENDZIFFERN_PATTERN = /^\d{4}$/;

function formWerte(body) {
  return {
    bezeichnung: (body.bezeichnung || '').trim(),
    karteEndziffern: (body.karteEndziffern || '').trim(),
    karteninhaberName: (body.karteninhaberName || '').trim(),
    verantwortlichId: body.verantwortlichId || '',
    // Keine Checkbox-Übermittlung = Modus B (nur Liste) -- gleiche Konvention wie die anderen Schalter.
    erfassungOffen: Boolean(body.erfassungOffen),
    erfasserIds: [].concat(body.erfasserIds || []),
    absenderMuster: (body.absenderMuster || '').trim(),
  };
}

export function createKreditkartenAdminRouter({ db, csrfProtection = (req, res, next) => next() }) {
  const router = Router();

  function validiere(werte) {
    const errors = [];
    if (!werte.bezeichnung) errors.push('Bitte eine Bezeichnung angeben.');
    if (werte.karteEndziffern && !ENDZIFFERN_PATTERN.test(werte.karteEndziffern)) errors.push('Endziffern müssen genau vier Ziffern sein (nie die ganze Kartennummer).');
    if (werte.absenderMuster && !isValidAbsenderMuster(werte.absenderMuster)) errors.push(ABSENDER_MUSTER_FEHLER);
    const verantwortlich = werte.verantwortlichId ? getPersonById(db, werte.verantwortlichId) : null;
    if (!verantwortlich || !verantwortlich.aktiv) errors.push('Bitte eine aktive verantwortliche Person wählen.');
    const aktiveIds = new Set(listActivePersons(db).map((p) => p.churchtools_person_id));
    if (werte.erfasserIds.some((id) => !aktiveIds.has(id))) errors.push('Die Erfasser-Liste enthält eine unbekannte Person.');
    return errors;
  }

  function renderForm(res, status, { karte, werte, errors }) {
    res.status(status).render('admin/kreditkarten-form', { karte, werte, errors, personen: listActivePersons(db) });
  }

  router.get('/', (req, res) => {
    const karten = listKreditkarten(db, { includeInactive: true }).map((k) => ({ ...k, verantwortlich: getPersonById(db, k.verantwortlich_id) }));
    res.render('admin/kreditkarten-liste', { karten });
  });

  router.get('/neu', (req, res) => {
    renderForm(res, 200, { karte: null, werte: formWerte({ erfassungOffen: '1' }), errors: [] });
  });

  router.post('/', csrfProtection, (req, res) => {
    const werte = formWerte(req.body);
    const errors = validiere(werte);
    if (errors.length > 0) return renderForm(res, 400, { karte: null, werte, errors });
    const id = createKreditkarte(db, werte);
    setErfasser(db, id, werte.erfassungOffen ? [] : werte.erfasserIds);
    res.redirect('/admin/kreditkarten');
  });

  router.get('/:id/bearbeiten', (req, res) => {
    const karte = getKreditkarteById(db, Number(req.params.id));
    if (!karte) return res.status(404).render('error', { message: 'Kreditkarte nicht gefunden.' });
    renderForm(res, 200, {
      karte,
      werte: {
        bezeichnung: karte.bezeichnung,
        karteEndziffern: karte.karte_endziffern || '',
        karteninhaberName: karte.karteninhaber_name || '',
        verantwortlichId: karte.verantwortlich_id,
        erfassungOffen: Boolean(karte.erfassung_offen),
        erfasserIds: listErfasserIds(db, karte.id),
        absenderMuster: karte.absender_muster || '',
      },
      errors: [],
    });
  });

  router.post('/:id', csrfProtection, (req, res) => {
    const karte = getKreditkarteById(db, Number(req.params.id));
    if (!karte) return res.status(404).render('error', { message: 'Kreditkarte nicht gefunden.' });
    const werte = formWerte(req.body);
    const errors = validiere(werte);
    if (errors.length > 0) return renderForm(res, 400, { karte, werte, errors });
    updateKreditkarte(db, karte.id, werte);
    setErfasser(db, karte.id, werte.erfassungOffen ? [] : werte.erfasserIds);
    res.redirect('/admin/kreditkarten');
  });

  router.post('/:id/deaktivieren', csrfProtection, (req, res) => {
    setKreditkarteAktiv(db, Number(req.params.id), false);
    res.redirect('/admin/kreditkarten');
  });

  router.post('/:id/aktivieren', csrfProtection, (req, res) => {
    setKreditkarteAktiv(db, Number(req.params.id), true);
    res.redirect('/admin/kreditkarten');
  });

  return router;
}
