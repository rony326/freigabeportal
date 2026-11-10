import { Router } from 'express';
import {
  createKreditor, updateKreditor, deactivateKreditor, activateKreditor, getKreditorById, listKreditoren,
  ZAHLUNGSARTEN, ZAHLUNGSART_LABEL, brauchtIban, istKreditorVollstaendig,
} from '../../db/kreditorenRepo.js';
import {
  createZuweisungsregel,
  updateZuweisungsregel,
  deleteZuweisungsregel,
  getZuweisungsregelById,
  listZuweisungsregeln,
  findZuweisungsregelByMuster,
} from '../../db/zuweisungsregelnRepo.js';
import { listKonten } from '../../db/kontenRepo.js';
import { createKreditorIban, deleteKreditorIban, getKreditorIbanById, listKreditorIbansAll, listKreditorIbansByKreditor, findKreditorIbanByIban } from '../../db/kreditorIbanRepo.js';
import { normalizeIban, isValidIbanInternational, ibanKurz } from '../../services/ibanUtils.js';
import { isValidAbsenderMuster, ABSENDER_MUSTER_FEHLER } from '../../utils/absenderMuster.js';
import { pruefeNeuenKreditor, legeKreditorAn } from '../../services/kreditorAnlegen.js';
import { kreditorIdAusEingabe, KreditorFeldKonflikt } from '../../services/kreditorFelder.js';

const IBAN_PFLICHT_FEHLER = 'Bei Überweisung und Dauerauftrag ist mindestens eine IBAN Pflicht.';
const IBAN_UNGUELTIG_FEHLER = 'IBAN ist ungültig (Prüfziffer oder Länge stimmt nicht).';
const LETZTE_IBAN_FEHLER = 'Die letzte IBAN kann nicht gelöscht werden, solange der Lieferant per Überweisung oder Dauerauftrag bezahlt wird.';

export function createKreditorenRouter({ db, csrfProtection = (req, res, next) => next() }) {
  const router = Router();

  function zahlungsartAusEingabe(body) {
    return body.zahlungsart || 'ueberweisung';
  }

  function renderListe(req, res, status, overrides = {}) {
    const konten = listKonten(db, { includeInactive: true });
    const kreditoren = listKreditoren(db, { includeInactive: true }).map((kreditor) => ({
      ...kreditor,
      konto: kreditor.konto_id ? konten.find((k) => k.id === kreditor.konto_id) : null,
      zahlungsartLabel: ZAHLUNGSART_LABEL[kreditor.zahlungsart] || kreditor.zahlungsart,
      unvollstaendig: kreditor.aktiv && !istKreditorVollstaendig(db, kreditor),
    }));
    const ohneIbanAnzahl = kreditoren.filter((k) => k.unvollstaendig).length;
    const regeln = listZuweisungsregeln(db).map((regel) => ({
      ...regel,
      kreditor: getKreditorById(db, regel.kreditor_id),
    }));
    const ibans = listKreditorIbansAll(db).map((row) => ({
      ...row,
      kreditor: getKreditorById(db, row.kreditor_id),
    }));
    res.status(status).render('admin/kreditoren-liste', {
      kreditoren,
      ohneIbanAnzahl,
      ZAHLUNGSARTEN,
      ZAHLUNGSART_LABEL,
      ibanKurz,
      regeln,
      ibans,
      konten: listKonten(db),
      aktiveKreditoren: listKreditoren(db),
      kreditorErrors: [],
      kreditorValues: { zahlungsart: 'ueberweisung' },
      regelErrors: [],
      regelValues: {},
      ibanErrors: [],
      ibanValues: {},
      gespeichert: req.query.gespeichert === '1',
      ...overrides,
    });
  }

  router.get('/', (req, res) => {
    renderListe(req, res, 200);
  });

  router.post('/', csrfProtection, (req, res) => {
    const { name, kontoId, iban } = req.body;
    const zahlungsart = zahlungsartAusEingabe(req.body);
    const betragSchwankt = req.body.betragSchwankt === 'on';
    const { errors, normalizedIban } = pruefeNeuenKreditor(db, { name, zahlungsart, iban });

    if (errors.length > 0) {
      return renderListe(req, res, 400, {
        kreditorErrors: errors,
        kreditorValues: { name, kontoId, iban, zahlungsart, betragSchwankt },
      });
    }

    legeKreditorAn(db, { name, kontoId, zahlungsart, betragSchwankt, normalizedIban });
    res.redirect('/admin/kreditoren?gespeichert=1');
  });

  // The /regeln* routes must be registered before the generic /:id* kreditor routes below —
  // otherwise POST/GET /admin/kreditoren/regeln(...) would first match router's `/:id` pattern
  // (with id="regeln", a NaN Number()) and 404 before ever reaching these handlers.
  router.post('/regeln', csrfProtection, (req, res) => {
    const { absenderMuster } = req.body;
    const kreditorId = kreditorIdAusEingabe(req.body);
    const errors = [];
    if (!absenderMuster) errors.push('Absender-Muster ist ein Pflichtfeld.');
    if (!kreditorId) errors.push('Kreditor ist ein Pflichtfeld.');
    if (absenderMuster && !isValidAbsenderMuster(absenderMuster)) {
      errors.push(ABSENDER_MUSTER_FEHLER);
    }
    if (absenderMuster && findZuweisungsregelByMuster(db, absenderMuster)) {
      errors.push('Dieses Absender-Muster ist bereits einem Kreditor zugewiesen.');
    }

    if (errors.length > 0) {
      return renderListe(req, res, 400, { regelErrors: errors, regelValues: { absenderMuster, kreditorId } });
    }

    createZuweisungsregel(db, { absenderMuster, kreditorId: Number(kreditorId) });
    res.redirect('/admin/kreditoren?gespeichert=1');
  });

  router.get('/regeln/:id/bearbeiten', (req, res) => {
    const regel = getZuweisungsregelById(db, Number(req.params.id));
    if (!regel) {
      return res.status(404).render('error', { message: 'Zuweisungsregel nicht gefunden.' });
    }
    res.render('admin/kreditoren-regel-form', {
      regel,
      values: { absenderMuster: regel.absender_muster, kreditorId: regel.kreditor_id },
      errors: [],
      kreditoren: listKreditoren(db),
    });
  });

  router.post('/regeln/:id', csrfProtection, (req, res) => {
    const id = Number(req.params.id);
    const regel = getZuweisungsregelById(db, id);
    if (!regel) {
      return res.status(404).render('error', { message: 'Zuweisungsregel nicht gefunden.' });
    }

    const { absenderMuster } = req.body;
    const kreditorId = kreditorIdAusEingabe(req.body);
    const errors = [];
    if (!absenderMuster) errors.push('Absender-Muster ist ein Pflichtfeld.');
    if (!kreditorId) errors.push('Kreditor ist ein Pflichtfeld.');
    if (absenderMuster && !isValidAbsenderMuster(absenderMuster)) {
      errors.push(ABSENDER_MUSTER_FEHLER);
    }
    const existing = absenderMuster ? findZuweisungsregelByMuster(db, absenderMuster) : null;
    if (existing && existing.id !== id) {
      errors.push('Dieses Absender-Muster ist bereits einem Kreditor zugewiesen.');
    }

    if (errors.length > 0) {
      return res.status(400).render('admin/kreditoren-regel-form', { regel, values: { absenderMuster, kreditorId }, errors, kreditoren: listKreditoren(db) });
    }

    updateZuweisungsregel(db, id, { absenderMuster, kreditorId: Number(kreditorId) });
    res.redirect('/admin/kreditoren?gespeichert=1');
  });

  router.post('/regeln/:id/loeschen', csrfProtection, (req, res) => {
    deleteZuweisungsregel(db, Number(req.params.id));
    res.redirect('/admin/kreditoren');
  });

  // The /ibans* routes must be registered before the generic /:id* kreditor routes below —
  // otherwise POST /admin/kreditoren/ibans(...) would first match router's `/:id` pattern
  // (with id="ibans", a NaN Number()) and 404 before ever reaching these handlers.
  router.post('/ibans', csrfProtection, (req, res) => {
    const { iban } = req.body;
    const kreditorId = kreditorIdAusEingabe(req.body);
    const normalizedIban = normalizeIban(iban);
    const errors = [];
    if (!normalizedIban) {
      errors.push('IBAN ist ein Pflichtfeld.');
    } else if (!isValidIbanInternational(normalizedIban)) {
      errors.push(IBAN_UNGUELTIG_FEHLER);
    } else if (findKreditorIbanByIban(db, normalizedIban)) {
      errors.push('Diese IBAN ist bereits einem Lieferanten zugeordnet.');
    }
    if (!kreditorId) errors.push('Lieferant ist ein Pflichtfeld.');

    if (errors.length > 0) {
      return renderListe(req, res, 400, { ibanErrors: errors, ibanValues: { iban, kreditorId } });
    }

    createKreditorIban(db, { kreditorId: Number(kreditorId), iban: normalizedIban, quelle: 'manuell' });
    res.redirect('/admin/kreditoren?gespeichert=1');
  });

  router.post('/ibans/:id/loeschen', csrfProtection, (req, res) => {
    const row = getKreditorIbanById(db, Number(req.params.id));
    if (row) {
      const kreditor = getKreditorById(db, row.kreditor_id);
      if (kreditor && brauchtIban(kreditor.zahlungsart) && listKreditorIbansByKreditor(db, kreditor.id).length <= 1) {
        return renderListe(req, res, 400, { ibanErrors: [LETZTE_IBAN_FEHLER] });
      }
      deleteKreditorIban(db, row.id);
    }
    res.redirect('/admin/kreditoren');
  });

  router.get('/:id/bearbeiten', (req, res) => {
    const kreditor = getKreditorById(db, Number(req.params.id));
    if (!kreditor) {
      return res.status(404).render('error', { message: 'Kreditor nicht gefunden.' });
    }
    res.render('admin/kreditoren-form', {
      kreditor,
      values: {
        name: kreditor.name,
        kontoId: kreditor.konto_id ? String(kreditor.konto_id) : '',
        zahlungsart: kreditor.zahlungsart,
        betragSchwankt: !!kreditor.betrag_schwankt,
      },
      errors: [],
      konten: listKonten(db),
      ZAHLUNGSARTEN,
      ZAHLUNGSART_LABEL,
    });
  });

  router.post('/:id', csrfProtection, (req, res) => {
    const id = Number(req.params.id);
    const kreditor = getKreditorById(db, id);
    if (!kreditor) {
      return res.status(404).render('error', { message: 'Kreditor nicht gefunden.' });
    }
    const { name, kontoId } = req.body;
    const zahlungsart = req.body.zahlungsart || kreditor.zahlungsart;
    const betragSchwankt = req.body.betragSchwankt === 'on';
    const errors = [];
    if (!name || !name.trim()) errors.push('Name ist ein Pflichtfeld.');
    if (!ZAHLUNGSARTEN.includes(zahlungsart)) {
      errors.push('Zahlungsart ist ungültig.');
    } else if (brauchtIban(zahlungsart) && listKreditorIbansByKreditor(db, id).length === 0) {
      errors.push(IBAN_PFLICHT_FEHLER);
    }

    if (errors.length > 0) {
      return res.status(400).render('admin/kreditoren-form', {
        kreditor, values: { name, kontoId, zahlungsart, betragSchwankt }, errors, konten: listKonten(db), ZAHLUNGSARTEN, ZAHLUNGSART_LABEL,
      });
    }

    updateKreditor(db, id, { name: name.trim(), kontoId: kontoId ? Number(kontoId) : null, zahlungsart, betragSchwankt });
    res.redirect('/admin/kreditoren?gespeichert=1');
  });

  router.post('/:id/deaktivieren', csrfProtection, (req, res) => {
    deactivateKreditor(db, Number(req.params.id));
    res.redirect('/admin/kreditoren?gespeichert=1');
  });

  router.post('/:id/aktivieren', csrfProtection, (req, res) => {
    activateKreditor(db, Number(req.params.id));
    res.redirect('/admin/kreditoren?gespeichert=1');
  });

  // Widerspruechliche alte/neue Feldnamen (kreditorId/debitorId) werden abgelehnt.
  router.use((err, req, res, next) => {
    if (err instanceof KreditorFeldKonflikt) return res.status(400).render('error', { message: err.message });
    next(err);
  });

  return router;
}
