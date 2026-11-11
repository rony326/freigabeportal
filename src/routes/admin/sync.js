// Admin → Sync-Übersicht (`/admin/sync`, Recht `sync_einsehen`, docs/personen-sync.md): Protokoll des ChurchTools-Personenabgleichs, Schutzgrenzen (Recht `sync_verwalten`) und "hängende" Vorgänge, deren zuständige Person nicht mehr handeln kann (Freigeben mit Recht `workflow_eingreifen`).

import { Router } from 'express';
import { getConfigValue, setConfigValue } from '../../db/adminConfigRepo.js';
import { listRecentSyncLogs } from '../../db/syncLogRepo.js';
import { listStalledJobs, forceReleaseJob, forceEskalierenFreigabe2AnAdmin } from '../../db/jobsRepo.js';
import { getPersonById } from '../../db/personenRepo.js';
import { requirePermission, personHasPermission } from '../../middleware/permissions.js';

// Hängende Vorgänge samt Namen der betroffenen Person.
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

export function createSyncRouter({ db, config = { churchtools: {} }, csrfProtection = (req, res, next) => next() }) {
  const router = Router();
  router.use((req, res, next) => {
    res.locals.canConfigureSync = personHasPermission(db, config, req.currentPerson, 'sync_verwalten');
    res.locals.canIntervene = personHasPermission(db, config, req.currentPerson, 'workflow_eingreifen');
    next();
  });

  // GET /admin/sync – Protokoll, Schutzgrenzen, hängende Vorgänge.
  router.get('/', (req, res) => {
    res.render('admin/sync', {
      maxDeaktivierungProzent: getConfigValue(db, 'sync_max_deaktivierung_prozent'),
      maxDeaktivierungAnzahl: getConfigValue(db, 'sync_max_deaktivierung_anzahl'),
      syncLog: listRecentSyncLogs(db, 20),
      stalledJobs: ladeStalledJobsMitNamen(db),
      errors: [],
      gespeichert: req.query.gespeichert === '1',
    });
  });

  // POST /admin/sync – speichert die Schutzgrenzen (Prozent und Anzahl, ab denen ein Sync-Lauf abbricht).
  router.post('/', requirePermission(db, config, 'sync_verwalten'), csrfProtection, (req, res, next) => {
    const { maxDeaktivierungProzent, maxDeaktivierungAnzahl } = req.body;
    const errors = [];

    const prozentNum = Number(maxDeaktivierungProzent);
    const anzahlNum = Number(maxDeaktivierungAnzahl);
    if (!Number.isInteger(prozentNum) || prozentNum <= 0 || prozentNum > 100) {
      errors.push('Max. Deaktivierungs-Prozentsatz muss eine Ganzzahl zwischen 1 und 100 sein.');
    }
    if (!Number.isInteger(anzahlNum) || anzahlNum <= 0) {
      errors.push('Max. Deaktivierungs-Anzahl muss eine positive Ganzzahl sein.');
    }

    if (errors.length > 0) {
      return res.status(400).render('admin/sync', {
        maxDeaktivierungProzent,
        maxDeaktivierungAnzahl,
        syncLog: listRecentSyncLogs(db, 20),
        stalledJobs: ladeStalledJobsMitNamen(db),
        errors,
        gespeichert: false,
      });
    }

    db.exec('BEGIN IMMEDIATE');
    try {
      setConfigValue(db, 'sync_max_deaktivierung_prozent', String(prozentNum));
      setConfigValue(db, 'sync_max_deaktivierung_anzahl', String(anzahlNum));
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      return next(err);
    }
    res.redirect('/admin/sync?gespeichert=1');
  });

  // POST /admin/sync/stalled/:jobId/freigeben – gibt einen hängenden Vorgang frei (Pool) bzw. eskaliert ihn an die Admin-Gruppe (Freigabe 2).
  router.post('/stalled/:jobId/freigeben', requirePermission(db, config, 'workflow_eingreifen'), csrfProtection, (req, res, next) => {
    const jobId = Number(req.params.jobId);
    const reason = typeof req.body?.begruendung === 'string' ? req.body.begruendung.trim() : '';
    if (!reason || reason.length > 2000) {
      return res.status(400).render('error', { message: 'Eine Begruendung (max. 2000 Zeichen) ist erforderlich.' });
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      const stalled = listStalledJobs(db).find(({ job }) => job.id === jobId);
      if (!stalled) {
        db.exec('ROLLBACK');
        return res.status(409).render('error', { message: 'Der Vorgang ist nicht mehr blockiert.' });
      }
      if (!forceReleaseJob(db, jobId)) forceEskalierenFreigabe2AnAdmin(db, jobId);
      db.prepare(`INSERT INTO audit_ereignisse
        (zeitpunkt, person_id, person_name, objekt, objekt_id, aktion, begruendung)
        VALUES (?, ?, ?, 'jobs', ?, 'workflow_eingriff', ?)`).run(
        new Date().toISOString(), req.currentPerson.churchtools_person_id,
        `${req.currentPerson.vorname} ${req.currentPerson.nachname}`, String(jobId), reason);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      return next(err);
    }
    res.redirect('/admin/sync');
  });

  return router;
}
