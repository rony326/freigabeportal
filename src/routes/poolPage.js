import { Router } from 'express';
import {
  listPoolJobs,
  listPoolRuecklaeufer,
  listZugewiesenJobsForPerson,
  listFreigabe2JobsForPerson,
  listAbgelehntJobsForPerson,
  listAdminEskalierteKontierungen,
  listAdminEskalierteFreigaben,
  listAdminEskalierteSpesenFreigaben,
  listSpesenFreigabe1JobsForPerson,
  getJobById,
  assignJobToPerson,
} from '../db/jobsRepo.js';
import { getKontoById, listPersonenMitFreigeberRolle } from '../db/kontenRepo.js';
import { buildSignedDownloadUrl, PDF_PREVIEW_TTL_SECONDS } from '../services/downloadUrl.js';
import { personHasRole } from '../middleware/roles.js';
import { personHasPermission, requirePermission } from '../middleware/permissions.js';
import { createFreigabe } from '../db/freigabenRepo.js';
import { sendNotification } from '../services/notify.js';
import { personName } from '../services/auditLog.js';

export function createPoolPageRouter({ db, config, mailer, csrfProtection = (req, res, next) => next() }) {
  const router = Router();

  function enrich(jobs) {
    return jobs.map((job) => ({
      ...job,
      previewUrl: buildSignedDownloadUrl(config, job.id, PDF_PREVIEW_TTL_SECONDS),
      kontonummer: job.konto_id ? (getKontoById(db, job.konto_id)?.kontonummer ?? null) : null,
      // Only meaningful while the job still sits unzugewiesen in the Pool — once it's actually
      // kontiert, the real Konto (above) takes over and this best-effort hint is moot.
      hinweisKonto: job.hinweis_konto_id ? (getKontoById(db, job.hinweis_konto_id) ?? null) : null,
      rueckgesendetVonName: job.pool_rueckgesendet_von ? personName(db, job.pool_rueckgesendet_von) : null,
    }));
  }

  router.get('/', (req, res) => {
    const personId = req.currentPerson.churchtools_person_id;
    // /pool is reachable by every logged-in person now (see app.js), but the company-wide pool of
    // unassigned invoices is still Buchhaltung/Portal-Admin business — skip the query entirely for
    // anyone else rather than relying on pool.ejs alone to hide it.
    const zeigtPool = personHasRole(req.currentPerson, config, 'buchhaltung') || personHasRole(req.currentPerson, config, 'superadmin');
    const istSuperadmin = personHasRole(req.currentPerson, config, 'superadmin');
    const kannZuweisen = personHasPermission(db, config, req.currentPerson, 'pool_zuweisen');
    res.render('pool', {
      poolJobs: zeigtPool ? enrich(listPoolJobs(db)) : [],
      ruecklaeufer: kannZuweisen ? enrich(listPoolRuecklaeufer(db)) : [],
      kannZuweisen,
      zielPersonen: kannZuweisen ? listPersonenMitFreigeberRolle(db) : [],
      meineKontierungen: enrich(listZugewiesenJobsForPerson(db, personId)),
      meineSpesenFreigaben: enrich(listSpesenFreigabe1JobsForPerson(db, personId)),
      meineFreigaben: enrich(listFreigabe2JobsForPerson(db, personId)),
      meineAbgelehnten: enrich(listAbgelehntJobsForPerson(db, personId)),
      adminEskalierteKontierungen: istSuperadmin ? enrich(listAdminEskalierteKontierungen(db)) : [],
      adminEskalierteFreigaben: istSuperadmin ? enrich(listAdminEskalierteFreigaben(db)) : [],
      adminEskalierteSpesenFreigaben: istSuperadmin ? enrich(listAdminEskalierteSpesenFreigaben(db)) : [],
    });
  });

  router.post('/:id/zuweisen', requirePermission(db, config, 'pool_zuweisen'), csrfProtection, async (req, res, next) => {
    try {
      const job = getJobById(db, Number(req.params.id));
      // quelle === 'spesen' mirrors the exclusion already applied by listPoolJobs/listPoolRuecklaeufer
      // above — a Spesen position never appears in either Pool list, so this route should never
      // reach one either. Not reachable via the UI, but a hand-crafted request could target one
      // directly by id, so this is defense in depth alongside the status check.
      if (!job || job.status !== 'unzugewiesen' || job.quelle === 'spesen') {
        return res.status(409).json({ error: 'Job ist nicht mehr im Pool verfügbar.' });
      }
      const zielPerson = listPersonenMitFreigeberRolle(db).find((p) => p.churchtools_person_id === req.body.personId);
      if (!zielPerson) {
        return res.status(400).json({ error: 'Bitte eine gültige Zielperson auswählen.' });
      }
      const zugewiesen = assignJobToPerson(db, job.id, zielPerson.churchtools_person_id);
      if (!zugewiesen) {
        return res.status(409).json({ error: 'Job ist nicht mehr im Pool verfügbar.' });
      }
      createFreigabe(db, {
        jobId: job.id,
        personId: req.currentPerson.churchtools_person_id,
        rolle: 'pool_zuweisung',
        zeitpunkt: new Date().toISOString(),
        ip: req.ip,
        interessenskonflikt: false,
        kommentar: `Zugewiesen an ${zielPerson.vorname} ${zielPerson.nachname}`,
        eskaliertVon: null,
      });
      await sendNotification(db, mailer, {
        to: zielPerson.email,
        typ: 'zuweisung',
        jobId: job.id,
        variablen: {
          empfaengerName: `${zielPerson.vorname} ${zielPerson.nachname}`,
          jobDateiname: job.dateiname,
          grund: `Eine Rechnung wurde dir von ${req.currentPerson.vorname} ${req.currentPerson.nachname} zur Kontierung zugewiesen.`,
          link: `${config.publicBaseUrl}/kontierung/${job.id}`,
        },
      });
      res.json({ id: job.id, status: 'zugewiesen' });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
