import { Router } from 'express';
import { getJobById } from '../db/jobsRepo.js';
import { getPersonById } from '../db/personenRepo.js';
import { buildSignedDownloadUrl, PDF_PREVIEW_TTL_SECONDS } from '../services/downloadUrl.js';
import { canViewJobPdf, darfRapportSehen } from '../services/jobAuthorization.js';
import { personHasPermission } from '../middleware/permissions.js';
import { aktuelleKenntnisnahmen, bestaetigeRapport } from '../services/rapporte.js';
import { kommentarBereich } from './kommentare.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

// Rapporte (nur zur Kenntnis): Detailseite mit Empfängerstatus und Knopf «Zur Kenntnis genommen».
export function createRapporteRouter({ db, config, csrfProtection = (req, res, next) => next() }) {
  const router = Router();
  const personName = (id) => {
    const p = id ? getPersonById(db, id) : null;
    return p ? `${p.vorname} ${p.nachname}` : id ? `Unbekannte Person (${id})` : '—';
  };

  // 404 für unbekannte Jobs und Nicht-Rapporte, 403 für Unbeteiligte; sonst der Job.
  function ladeRapport(req, res) {
    const job = /^\d+$/.test(req.params.id) ? getJobById(db, Number(req.params.id)) : null;
    if (!job || job.typ !== 'rapport') {
      res.status(404).render('error', { message: 'Rapport nicht gefunden.' });
      return null;
    }
    if (!darfRapportSehen(db, config, req.currentPerson, job)) {
      res.status(403).render('error', { message: 'Kein Zugriff auf diesen Rapport.' });
      return null;
    }
    return job;
  }

  router.get('/:id', (req, res) => {
    const job = ladeRapport(req, res);
    if (!job) return;
    const personId = req.currentPerson.churchtools_person_id;
    const zeilen = aktuelleKenntnisnahmen(db, job);
    const nachId = new Map(zeilen.map((k) => [k.id, k]));
    const empfaenger = zeilen.map((k) => ({
      name: personName(k.person_id),
      bestaetigtAm: k.bestaetigt_am,
      entferntAm: k.entfernt_am,
      entferntVon: k.entfernt_von ? personName(k.entfernt_von) : null,
      begruendung: k.begruendung,
      ersetztDurch: k.ersetzt_durch_id ? personName(nachId.get(k.ersetzt_durch_id)?.person_id) : null,
    }));
    const bestaetigt = zeilen.filter((k) => k.bestaetigt_am).length;
    const offen = job.status === 'kenntnisnahme';
    const eigeneOffen = offen && zeilen.some((k) => k.person_id === personId && !k.bestaetigt_am && !k.entfernt_am);
    const darfAufheben = offen && bestaetigt === 0
      && (job.rapport_markiert_von === personId || personHasPermission(db, config, req.currentPerson, 'workflow_eingreifen'));
    const pdfSichtbar = canViewJobPdf(db, config, req.currentPerson, job);
    res.render('rapport', {
      job,
      markiertVonName: personName(job.rapport_markiert_von),
      empfaenger,
      bestaetigt,
      gesamt: zeilen.filter((k) => !k.entfernt_am).length,
      eigeneOffen,
      darfAufheben,
      pdfSichtbar,
      previewUrl: pdfSichtbar ? buildSignedDownloadUrl(config, job.id, PDF_PREVIEW_TTL_SECONDS) : null,
      kommentarBereich: kommentarBereich(db, config, req.currentPerson, job, `/rapporte/${job.id}`),
    });
  });

  router.post('/:id/bestaetigen', csrfProtection, asyncHandler(async (req, res) => {
    const job = ladeRapport(req, res);
    if (!job) return;
    const ergebnis = await bestaetigeRapport(db, config, { jobId: job.id, person: req.currentPerson, ip: req.ip });
    if (!ergebnis.ok) return res.status(ergebnis.status).render('error', { message: ergebnis.fehler });
    res.redirect(`/rapporte/${job.id}`);
  }));

  return router;
}
