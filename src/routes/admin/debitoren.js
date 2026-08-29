import { Router } from 'express';
import { createDebitor, updateDebitor, deactivateDebitor, activateDebitor, getDebitorById, listDebitoren } from '../../db/debitorenRepo.js';
import {
  createZuweisungsregel,
  updateZuweisungsregel,
  deleteZuweisungsregel,
  getZuweisungsregelById,
  listZuweisungsregeln,
  findZuweisungsregelByMuster,
} from '../../db/zuweisungsregelnRepo.js';
import { listKonten } from '../../db/kontenRepo.js';
import { createDebitorIban, deleteDebitorIban, listDebitorIbansAll, findDebitorIbanByIban } from '../../db/debitorIbanRepo.js';
import { normalizeIban, isValidIban } from '../../services/ibanUtils.js';

const EMAIL_MUSTER_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DOMAIN_MUSTER_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

function isValidAbsenderMuster(muster) {
  return muster.includes('@') ? EMAIL_MUSTER_PATTERN.test(muster) : DOMAIN_MUSTER_PATTERN.test(muster);
}

export function createDebitorenRouter({ db, csrfProtection = (req, res, next) => next() }) {
  const router = Router();

  function renderListe(req, res, status, overrides = {}) {
    const konten = listKonten(db, { includeInactive: true });
    const debitoren = listDebitoren(db, { includeInactive: true }).map((debitor) => ({
      ...debitor,
      konto: debitor.konto_id ? konten.find((k) => k.id === debitor.konto_id) : null,
    }));
    const regeln = listZuweisungsregeln(db).map((regel) => ({
      ...regel,
      debitor: getDebitorById(db, regel.debitor_id),
    }));
    const ibans = listDebitorIbansAll(db).map((row) => ({
      ...row,
      debitor: getDebitorById(db, row.debitor_id),
    }));
    res.status(status).render('admin/debitoren-liste', {
      debitoren,
      regeln,
      ibans,
      konten: listKonten(db),
      aktiveDebitoren: listDebitoren(db),
      debitorErrors: [],
      debitorValues: {},
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
    const { name, kontoId } = req.body;
    const errors = [];
    if (!name || !name.trim()) errors.push('Name ist ein Pflichtfeld.');

    if (errors.length > 0) {
      return renderListe(req, res, 400, { debitorErrors: errors, debitorValues: { name, kontoId } });
    }

    createDebitor(db, { name: name.trim(), kontoId: kontoId ? Number(kontoId) : null });
    res.redirect('/admin/debitoren?gespeichert=1');
  });

  // The /regeln* routes must be registered before the generic /:id* debitor routes below —
  // otherwise POST/GET /admin/debitoren/regeln(...) would first match router's `/:id` pattern
  // (with id="regeln", a NaN Number()) and 404 before ever reaching these handlers.
  router.post('/regeln', csrfProtection, (req, res) => {
    const { absenderMuster, debitorId } = req.body;
    const errors = [];
    if (!absenderMuster) errors.push('Absender-Muster ist ein Pflichtfeld.');
    if (!debitorId) errors.push('Debitor ist ein Pflichtfeld.');
    if (absenderMuster && !isValidAbsenderMuster(absenderMuster)) {
      errors.push('Absender-Muster muss eine gültige E-Mail-Adresse oder Domain sein (z. B. "lieferant.ch" oder "rechnung@lieferant.ch").');
    }
    if (absenderMuster && findZuweisungsregelByMuster(db, absenderMuster)) {
      errors.push('Dieses Absender-Muster ist bereits einem Debitor zugewiesen.');
    }

    if (errors.length > 0) {
      return renderListe(req, res, 400, { regelErrors: errors, regelValues: { absenderMuster, debitorId } });
    }

    createZuweisungsregel(db, { absenderMuster, debitorId: Number(debitorId) });
    res.redirect('/admin/debitoren?gespeichert=1');
  });

  router.get('/regeln/:id/bearbeiten', (req, res) => {
    const regel = getZuweisungsregelById(db, Number(req.params.id));
    if (!regel) {
      return res.status(404).render('error', { message: 'Zuweisungsregel nicht gefunden.' });
    }
    res.render('admin/debitoren-regel-form', {
      regel,
      values: { absenderMuster: regel.absender_muster, debitorId: regel.debitor_id },
      errors: [],
      debitoren: listDebitoren(db),
    });
  });

  router.post('/regeln/:id', csrfProtection, (req, res) => {
    const id = Number(req.params.id);
    const regel = getZuweisungsregelById(db, id);
    if (!regel) {
      return res.status(404).render('error', { message: 'Zuweisungsregel nicht gefunden.' });
    }

    const { absenderMuster, debitorId } = req.body;
    const errors = [];
    if (!absenderMuster) errors.push('Absender-Muster ist ein Pflichtfeld.');
    if (!debitorId) errors.push('Debitor ist ein Pflichtfeld.');
    if (absenderMuster && !isValidAbsenderMuster(absenderMuster)) {
      errors.push('Absender-Muster muss eine gültige E-Mail-Adresse oder Domain sein (z. B. "lieferant.ch" oder "rechnung@lieferant.ch").');
    }
    const existing = absenderMuster ? findZuweisungsregelByMuster(db, absenderMuster) : null;
    if (existing && existing.id !== id) {
      errors.push('Dieses Absender-Muster ist bereits einem Debitor zugewiesen.');
    }

    if (errors.length > 0) {
      return res.status(400).render('admin/debitoren-regel-form', { regel, values: { absenderMuster, debitorId }, errors, debitoren: listDebitoren(db) });
    }

    updateZuweisungsregel(db, id, { absenderMuster, debitorId: Number(debitorId) });
    res.redirect('/admin/debitoren?gespeichert=1');
  });

  router.post('/regeln/:id/loeschen', csrfProtection, (req, res) => {
    deleteZuweisungsregel(db, Number(req.params.id));
    res.redirect('/admin/debitoren');
  });

  // The /ibans* routes must be registered before the generic /:id* debitor routes below —
  // otherwise POST /admin/debitoren/ibans(...) would first match router's `/:id` pattern
  // (with id="ibans", a NaN Number()) and 404 before ever reaching these handlers.
  router.post('/ibans', csrfProtection, (req, res) => {
    const { iban, debitorId } = req.body;
    const normalizedIban = normalizeIban(iban);
    const errors = [];
    if (!normalizedIban) {
      errors.push('IBAN ist ein Pflichtfeld.');
    } else if (!isValidIban(normalizedIban)) {
      errors.push('IBAN muss eine gültige Schweizer IBAN sein (z. B. "CH93 0076 2011 6238 5295 7").');
    } else if (findDebitorIbanByIban(db, normalizedIban)) {
      errors.push('Diese IBAN ist bereits einem Lieferanten zugeordnet.');
    }
    if (!debitorId) errors.push('Lieferant ist ein Pflichtfeld.');

    if (errors.length > 0) {
      return renderListe(req, res, 400, { ibanErrors: errors, ibanValues: { iban, debitorId } });
    }

    createDebitorIban(db, { debitorId: Number(debitorId), iban: normalizedIban, quelle: 'manuell' });
    res.redirect('/admin/debitoren?gespeichert=1');
  });

  router.post('/ibans/:id/loeschen', csrfProtection, (req, res) => {
    deleteDebitorIban(db, Number(req.params.id));
    res.redirect('/admin/debitoren');
  });

  router.get('/:id/bearbeiten', (req, res) => {
    const debitor = getDebitorById(db, Number(req.params.id));
    if (!debitor) {
      return res.status(404).render('error', { message: 'Debitor nicht gefunden.' });
    }
    res.render('admin/debitoren-form', {
      debitor,
      values: { name: debitor.name, kontoId: debitor.konto_id ? String(debitor.konto_id) : '' },
      errors: [],
      konten: listKonten(db),
    });
  });

  router.post('/:id', csrfProtection, (req, res) => {
    const id = Number(req.params.id);
    const debitor = getDebitorById(db, id);
    if (!debitor) {
      return res.status(404).render('error', { message: 'Debitor nicht gefunden.' });
    }
    const { name, kontoId } = req.body;
    const errors = [];
    if (!name || !name.trim()) errors.push('Name ist ein Pflichtfeld.');

    if (errors.length > 0) {
      return res.status(400).render('admin/debitoren-form', { debitor, values: { name, kontoId }, errors, konten: listKonten(db) });
    }

    updateDebitor(db, id, { name: name.trim(), kontoId: kontoId ? Number(kontoId) : null });
    res.redirect('/admin/debitoren?gespeichert=1');
  });

  router.post('/:id/deaktivieren', csrfProtection, (req, res) => {
    deactivateDebitor(db, Number(req.params.id));
    res.redirect('/admin/debitoren?gespeichert=1');
  });

  router.post('/:id/aktivieren', csrfProtection, (req, res) => {
    activateDebitor(db, Number(req.params.id));
    res.redirect('/admin/debitoren?gespeichert=1');
  });

  return router;
}
