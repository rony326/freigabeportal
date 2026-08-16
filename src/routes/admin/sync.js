import { Router } from 'express';
import { getConfigValue, setConfigValue } from '../../db/adminConfigRepo.js';
import { listRecentSyncLogs } from '../../db/syncLogRepo.js';
import { listStalledJobs, forceReleaseJob, forceEskalierenFreigabe2AnAdmin } from '../../db/jobsRepo.js';
import { getPersonById } from '../../db/personenRepo.js';
import { validateEmpfaengerListe } from './eskalation.js';

function ladeStalledJobsMitNamen(db) {
  return listStalledJobs(db).map(({ job, akteurId, grund }) => {
    const akteur = getPersonById(db, akteurId);
    return {
      job,
      akteurName: akteur ? `${akteur.vorname} ${akteur.nachname}` : akteurId,
      grund,
    };
  });
}

export function createSyncRouter({ db }) {
  const router = Router();

  router.get('/', (req, res) => {
    res.render('admin/sync', {
      maxDeaktivierungProzent: getConfigValue(db, 'sync_max_deaktivierung_prozent'),
      maxDeaktivierungAnzahl: getConfigValue(db, 'sync_max_deaktivierung_anzahl'),
      syncFehlerEmpfaenger: getConfigValue(db, 'sync_fehler_empfaenger'),
      syncLog: listRecentSyncLogs(db, 20),
      stalledJobs: ladeStalledJobsMitNamen(db),
      errors: [],
    });
  });

  router.post('/', (req, res) => {
    const { maxDeaktivierungProzent, maxDeaktivierungAnzahl, syncFehlerEmpfaenger } = req.body;
    const errors = [];

    const prozentNum = Number(maxDeaktivierungProzent);
    const anzahlNum = Number(maxDeaktivierungAnzahl);
    if (!Number.isInteger(prozentNum) || prozentNum <= 0 || prozentNum > 100) {
      errors.push('Max. Deaktivierungs-Prozentsatz muss eine Ganzzahl zwischen 1 und 100 sein.');
    }
    if (!Number.isInteger(anzahlNum) || anzahlNum <= 0) {
      errors.push('Max. Deaktivierungs-Anzahl muss eine positive Ganzzahl sein.');
    }
    validateEmpfaengerListe(syncFehlerEmpfaenger, 'Sync-Fehler-Empfänger', errors);

    if (errors.length > 0) {
      return res.status(400).render('admin/sync', {
        maxDeaktivierungProzent,
        maxDeaktivierungAnzahl,
        syncFehlerEmpfaenger,
        syncLog: listRecentSyncLogs(db, 20),
        stalledJobs: ladeStalledJobsMitNamen(db),
        errors,
      });
    }

    setConfigValue(db, 'sync_max_deaktivierung_prozent', String(prozentNum));
    setConfigValue(db, 'sync_max_deaktivierung_anzahl', String(anzahlNum));
    setConfigValue(db, 'sync_fehler_empfaenger', syncFehlerEmpfaenger.trim());
    res.redirect('/admin/sync');
  });

  router.post('/stalled/:jobId/freigeben', (req, res) => {
    const jobId = Number(req.params.jobId);
    // Try the pool-release path first (covers zugewiesen/abgelehnt); if that's not the job's
    // status, fall back to the admin-escalation path (covers freigabe2). Exactly one of the two
    // can ever apply to a given status, so trying both in order is safe and needs no extra
    // status lookup here.
    if (!forceReleaseJob(db, jobId)) {
      forceEskalierenFreigabe2AnAdmin(db, jobId);
    }
    res.redirect('/admin/sync');
  });

  return router;
}
