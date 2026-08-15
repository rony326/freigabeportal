import { Router } from 'express';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { getJobById, eskalierenFreigabe2, abschliessenFreigabe2, getEffectiveFreigeber2Id } from '../db/jobsRepo.js';
import { getKontoById } from '../db/kontenRepo.js';
import { createFreigabe, listFreigabenByJob } from '../db/freigabenRepo.js';
import { getPersonById } from '../db/personenRepo.js';
import { getConfigValue } from '../db/adminConfigRepo.js';
import { stampAndFinalize } from '../services/pdfStamp.js';
import { buildSignedDownloadUrl, PDF_PREVIEW_TTL_SECONDS } from '../services/downloadUrl.js';

export function createFreigabe2Router({ db, config }) {
  const router = Router();

  function loadAuthorized(req, res) {
    const job = getJobById(db, Number(req.params.id));
    if (!job || job.status !== 'freigabe2') {
      res.status(403).render('error', { message: 'Für diesen Job ist aktuell keine Freigabe 2 möglich.' });
      return null;
    }
    const konto = getKontoById(db, job.konto_id);
    if (!konto || getEffectiveFreigeber2Id(job, konto) !== req.currentPerson.churchtools_person_id) {
      res.status(403).render('error', { message: 'Du bist für die Freigabe 2 dieses Jobs nicht zuständig.' });
      return null;
    }
    return { job, konto };
  }

  function renderForm(req, res, status, { job, konto }, values, errors) {
    const freigaben = listFreigabenByJob(db, job.id);
    const freigabe1 = freigaben.find((f) => f.rolle === 'freigeber1');
    const freigeber1Person = getPersonById(db, freigabe1.person_id);
    res.status(status).render('freigabe2', {
      job,
      konto,
      freigabe1,
      freigeber1Person,
      previewUrl: buildSignedDownloadUrl(config, job.id, PDF_PREVIEW_TTL_SECONDS),
      values,
      errors,
    });
  }

  router.get('/:id', (req, res) => {
    const result = loadAuthorized(req, res);
    if (!result) return;
    renderForm(req, res, 200, result, { interessenskonflikt: '', begruendung: '' }, []);
  });

  router.post('/:id', async (req, res) => {
    const result = loadAuthorized(req, res);
    if (!result) return;
    const { job, konto } = result;
    const { interessenskonflikt, begruendung } = req.body;
    const hatKonflikt = interessenskonflikt === 'ja';

    if (hatKonflikt && !begruendung) {
      return renderForm(req, res, 400, result, { interessenskonflikt, begruendung }, ['Bei einem Interessenskonflikt ist eine Begründung Pflicht.']);
    }

    if (hatKonflikt) {
      db.exec('BEGIN');
      try {
        eskalierenFreigabe2(db, job.id, { eskaliertVon: req.currentPerson.churchtools_person_id, grund: begruendung });
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      return res.redirect('/pool');
    }

    const freigaben = listFreigabenByJob(db, job.id);
    const freigabe1 = freigaben.find((f) => f.rolle === 'freigeber1');
    const freigeber1Person = getPersonById(db, freigabe1.person_id);
    const zeitpunkt = new Date().toISOString();
    const stampData = {
      freigeber1: {
        name: `${freigeber1Person.vorname} ${freigeber1Person.nachname}`,
        identitaet: freigeber1Person.churchtools_person_id,
        zeitpunkt: freigabe1.zeitpunkt,
        ip: freigabe1.ip,
        interessenskonflikt: Boolean(freigabe1.interessenskonflikt),
        kommentar: freigabe1.kommentar,
      },
      freigeber2: {
        name: `${req.currentPerson.vorname} ${req.currentPerson.nachname}`,
        identitaet: req.currentPerson.churchtools_person_id,
        zeitpunkt,
        ip: req.ip,
        interessenskonflikt: false,
        kommentar: null,
      },
    };

    let stamped;
    try {
      const pdfBuffer = readFileSync(job.pdf_pfad);
      const position = getConfigValue(db, 'visum_seite_position') || 'letzte';
      stamped = await stampAndFinalize(pdfBuffer, stampData, position);
    } catch (err) {
      return renderForm(req, res, 400, result, { interessenskonflikt, begruendung }, [err.message]);
    }

    const tmpPfad = `${job.pdf_pfad}.tmp`;
    writeFileSync(tmpPfad, stamped);
    renameSync(tmpPfad, job.pdf_pfad);

    db.exec('BEGIN');
    try {
      createFreigabe(db, {
        jobId: job.id,
        personId: req.currentPerson.churchtools_person_id,
        rolle: 'freigeber2',
        zeitpunkt,
        ip: req.ip,
        interessenskonflikt: false,
        kommentar: null,
        eskaliertVon: job.freigabe2_eskaliert_von,
      });
      abschliessenFreigabe2(db, job.id);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    res.redirect('/pool');
  });

  return router;
}
