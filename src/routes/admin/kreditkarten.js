// Admin → Kreditkarten (`/admin/kreditkarten`, Recht `kreditkarten_verwalten`, docs/kreditkarten-belege.md): Karten mit Bezeichnung, Endziffern, Karteninhaber, verantwortlicher Person, offener oder eingeschränkter Erfassung (Erfasser-Liste) und Absender-Muster für die Erkennung anlegen, ändern, (de)aktivieren.

import { Router } from 'express';
import {
  createKreditkarte, updateKreditkarte, setKreditkarteAktiv, getKreditkarteById, listKreditkarten, listErfasserIds, setErfasser,
} from '../../db/kreditkartenRepo.js';
import { listActivePersons, getPersonById } from '../../db/personenRepo.js';
import { isValidAbsenderMuster, ABSENDER_MUSTER_FEHLER } from '../../utils/absenderMuster.js';

const ENDZIFFERN_PATTERN = /^\d{4}$/;

// Liest und bereinigt die Formularwerte.
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

  // Prüft die Werte (Bezeichnung, 4 Endziffern, verantwortliche Person, Absender-Muster).
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

  // Rendert das Formular.
  function renderForm(res, status, { karte, werte, errors }) {
    res.status(status).render('admin/kreditkarten-form', { karte, werte, errors, personen: listActivePersons(db) });
  }

  // GET /admin/kreditkarten – Liste.
  router.get('/', (req, res) => {
    const karten = listKreditkarten(db, { includeInactive: true }).map((k) => ({ ...k, verantwortlich: getPersonById(db, k.verantwortlich_id) }));
    res.render('admin/kreditkarten-liste', { karten });
  });

  // GET /admin/kreditkarten/neu – Formular.
  router.get('/neu', (req, res) => {
    renderForm(res, 200, { karte: null, werte: formWerte({ erfassungOffen: '1' }), errors: [] });
  });

  // POST /admin/kreditkarten – legt eine Karte an.
  router.post('/', csrfProtection, (req, res) => {
    const werte = formWerte(req.body);
    const errors = validiere(werte);
    if (errors.length > 0) return renderForm(res, 400, { karte: null, werte, errors });
    const id = createKreditkarte(db, werte);
    setErfasser(db, id, werte.erfassungOffen ? [] : werte.erfasserIds);
    res.redirect('/admin/kreditkarten');
  });

  // GET /admin/kreditkarten/:id/bearbeiten – Bearbeitungsformular.
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

  // POST /admin/kreditkarten/:id – speichert Änderungen (Erfasser-Liste wird komplett ersetzt).
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

  // POST /admin/kreditkarten/:id/deaktivieren – Karte abschalten.
  router.post('/:id/deaktivieren', csrfProtection, (req, res) => {
    setKreditkarteAktiv(db, Number(req.params.id), false);
    res.redirect('/admin/kreditkarten');
  });

  // POST /admin/kreditkarten/:id/aktivieren – Karte wieder einschalten.
  router.post('/:id/aktivieren', csrfProtection, (req, res) => {
    setKreditkarteAktiv(db, Number(req.params.id), true);
    res.redirect('/admin/kreditkarten');
  });

  return router;
}
