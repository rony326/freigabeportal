import { Router } from 'express';
import {
  createZuweisungsregel,
  updateZuweisungsregel,
  deleteZuweisungsregel,
  getZuweisungsregelById,
  listZuweisungsregeln,
  findZuweisungsregelByMuster,
} from '../../db/zuweisungsregelnRepo.js';
import { listKonten } from '../../db/kontenRepo.js';

const EMAIL_MUSTER_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DOMAIN_MUSTER_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

function isValidAbsenderMuster(muster) {
  return muster.includes('@') ? EMAIL_MUSTER_PATTERN.test(muster) : DOMAIN_MUSTER_PATTERN.test(muster);
}

export function createZuweisungsregelnRouter({ db }) {
  const router = Router();

  router.get('/', (req, res) => {
    res.render('admin/zuweisungsregeln-liste', { regeln: listZuweisungsregeln(db) });
  });

  router.get('/neu', (req, res) => {
    res.render('admin/zuweisungsregeln-form', { regel: null, values: {}, errors: [], konten: listKonten(db) });
  });

  router.post('/', (req, res) => {
    const { absenderMuster, kontoId } = req.body;
    const errors = [];
    if (!absenderMuster) errors.push('Absender-Muster ist ein Pflichtfeld.');
    if (!kontoId) errors.push('Konto ist ein Pflichtfeld.');
    if (absenderMuster && !isValidAbsenderMuster(absenderMuster)) {
      errors.push('Absender-Muster muss eine gültige E-Mail-Adresse oder Domain sein (z. B. "lieferant.ch" oder "rechnung@lieferant.ch").');
    }
    if (absenderMuster && findZuweisungsregelByMuster(db, absenderMuster)) {
      errors.push('Dieses Absender-Muster ist bereits einem Konto zugewiesen.');
    }

    if (errors.length > 0) {
      return res.status(400).render('admin/zuweisungsregeln-form', { regel: null, values: { absenderMuster, kontoId }, errors, konten: listKonten(db) });
    }

    createZuweisungsregel(db, { absenderMuster, kontoId: Number(kontoId) });
    res.redirect('/admin/zuweisungsregeln');
  });

  router.get('/:id/bearbeiten', (req, res) => {
    const regel = getZuweisungsregelById(db, Number(req.params.id));
    if (!regel) {
      return res.status(404).render('error', { message: 'Zuweisungsregel nicht gefunden.' });
    }
    res.render('admin/zuweisungsregeln-form', {
      regel,
      values: { absenderMuster: regel.absender_muster, kontoId: regel.konto_id },
      errors: [],
      konten: listKonten(db),
    });
  });

  router.post('/:id', (req, res) => {
    const id = Number(req.params.id);
    const regel = getZuweisungsregelById(db, id);
    if (!regel) {
      return res.status(404).render('error', { message: 'Zuweisungsregel nicht gefunden.' });
    }

    const { absenderMuster, kontoId } = req.body;
    const errors = [];
    if (!absenderMuster) errors.push('Absender-Muster ist ein Pflichtfeld.');
    if (!kontoId) errors.push('Konto ist ein Pflichtfeld.');
    if (absenderMuster && !isValidAbsenderMuster(absenderMuster)) {
      errors.push('Absender-Muster muss eine gültige E-Mail-Adresse oder Domain sein (z. B. "lieferant.ch" oder "rechnung@lieferant.ch").');
    }
    const existing = absenderMuster ? findZuweisungsregelByMuster(db, absenderMuster) : null;
    if (existing && existing.id !== id) {
      errors.push('Dieses Absender-Muster ist bereits einem Konto zugewiesen.');
    }

    if (errors.length > 0) {
      return res.status(400).render('admin/zuweisungsregeln-form', { regel, values: { absenderMuster, kontoId }, errors, konten: listKonten(db) });
    }

    updateZuweisungsregel(db, id, { absenderMuster, kontoId: Number(kontoId) });
    res.redirect('/admin/zuweisungsregeln');
  });

  router.post('/:id/loeschen', (req, res) => {
    deleteZuweisungsregel(db, Number(req.params.id));
    res.redirect('/admin/zuweisungsregeln');
  });

  return router;
}
