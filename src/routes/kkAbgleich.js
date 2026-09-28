import { Router } from 'express';
import { getKreditkarteById } from '../db/kreditkartenRepo.js';
import { listOffeneKkBelegeFuerKarte } from '../db/kkBelegeRepo.js';
import { listKonten } from '../db/kontenRepo.js';
import { listDebitoren } from '../db/debitorenRepo.js';
import { getPersonById } from '../db/personenRepo.js';
import { buildSignedDownloadUrl, PDF_PREVIEW_TTL_SECONDS } from '../services/downloadUrl.js';
import { buildAuditLog } from '../services/auditLog.js';
import { ladeKontierbarenJob, ladeKontenFuerJob } from '../services/kontierungZugriff.js';

function personLabel(db, id) {
  const p = id ? getPersonById(db, id) : null;
  return p ? `${p.vorname} ${p.nachname}` : 'Unbekannt';
}

export function createKkAbgleichRouter({ db, config, mailer, csrfProtection = (req, res, next) => next() }) {
  const router = Router();

  function ladeAbrechnung(req, res) {
    const job = ladeKontierbarenJob(db, config, req, res);
    if (!job) return null;
    if (!job.kreditkarte_id) {
      res.status(409).render('error', { message: 'Diese Rechnung ist keiner Kreditkarte zugeordnet.' });
      return null;
    }
    return job;
  }

  function offeneBelege(karteId) {
    return listOffeneKkBelegeFuerKarte(db, karteId).map((b) => ({
      ...b,
      gekauftVonName: personLabel(db, b.gekauft_von),
      hochgeladenVonName: personLabel(db, b.hochgeladen_von),
    }));
  }

  function renderSeite(req, res, status, job, { werte, zeilen, errors }) {
    const karte = getKreditkarteById(db, job.kreditkarte_id);
    res.status(status).render('kk-abgleich', {
      job,
      karte,
      belege: offeneBelege(karte.id),
      alleKonten: listKonten(db),
      eigeneKontoIds: ladeKontenFuerJob(db, req, job).map((k) => k.id),
      debitoren: listDebitoren(db),
      previewUrl: buildSignedDownloadUrl(config, job.id, PDF_PREVIEW_TTL_SECONDS),
      werte,
      zeilen,
      errors,
      auditLog: buildAuditLog(db, job.id),
    });
  }

  router.get('/:id/kk-abgleich', (req, res) => {
    const job = ladeAbrechnung(req, res);
    if (!job) return;
    renderSeite(req, res, 200, job, {
      werte: {
        gesamtbetrag: job.betrag || job.qr_betrag || '',
        debitorId: job.debitor_id ? String(job.debitor_id) : '',
        rechnungsnummer: job.rechnungsnummer || '',
        zahlungsziel: job.zahlungsziel || '',
        begruendung: '',
      },
      zeilen: [],
      errors: [],
    });
  });

  // POST kommt in Task 9.

  return router;
}
