// Seite "Abgelehnt" (`/abgelehnt/:id`): die zugewiesene Person (oder ihre Vertretung; bei Eskalation ein Superadmin) sieht den Ablehnungsgrund und
// öffnet den Vorgang zur Überarbeitung wieder (Rückweg in die Kontierung). Spesen gehören nicht hierher. Fachlich: docs/rechnungs-workflow.md, "Ablehnung".
// Zugang: angemeldet (app.js `requireLogin`); die Berechtigung je Vorgang prüft `loadAuthorizedJob`.

import { personHasRole } from '../middleware/roles.js';
import { Router } from 'express';
import { getJobById, wiederOeffnenJob } from '../db/jobsRepo.js';
import { getPersonById } from '../db/personenRepo.js';
import { listFreigabenByJob } from '../db/freigabenRepo.js';
import { buildAuditLog } from '../services/auditLog.js';
import { istAktiveVertretungFuer } from '../services/vertretung.js';
import { kommentarBereich } from './kommentare.js';

export function createAblehnungRouter({ db, config, csrfProtection = (req, res, next) => next() }) {
  const router = Router();

  function isSuperadmin(person) {
    return personHasRole(person, config, 'superadmin');
  }

  // Lädt den abgelehnten Vorgang und prüft die Berechtigung; bei Mangel 403 gerendert und null geliefert.
  function loadAuthorizedJob(req, res) {
    const job = getJobById(db, Number(req.params.id));
    if (!job || job.status !== 'abgelehnt') {
      res.status(403).render('error', { message: 'Dieser Job ist für dich aktuell nicht zur Überarbeitung verfügbar.' });
      return null;
    }
    // Eine abgelehnte Spesenposition erfüllt die Prüfungen auf Status/zugewiesen_an unten genau wie eine gewöhnliche Rechnung; /:id/ueberarbeiten würde so
    // still ablehnungsgrund löschen und nach /kontierung/:id umleiten — falsch für Spesen (siehe die identische Sperre in kontierung.js).
    if (job.quelle === 'spesen') {
      res.status(403).render('error', { message: 'Diese Spesen-Position kann nicht über die Kontierung bearbeitet werden.' });
      return null;
    }
    const authorized = job.freigabe1_eskaliert_an_admin
      ? isSuperadmin(req.currentPerson)
      : job.zugewiesen_an === req.currentPerson.churchtools_person_id ||
        istAktiveVertretungFuer(db, req.currentPerson.churchtools_person_id, job.zugewiesen_an);
    if (!authorized) {
      res.status(403).render('error', { message: 'Dieser Job ist für dich aktuell nicht zur Überarbeitung verfügbar.' });
      return null;
    }
    return job;
  }

  // GET /abgelehnt/:id – zeigt Ablehnungsgrund, Verlauf und Kommentare.
  router.get('/:id', (req, res) => {
    const job = loadAuthorizedJob(req, res);
    if (!job) return;
    const abgelehntVonPerson = getPersonById(db, job.abgelehnt_von);
    const ablehnung = listFreigabenByJob(db, job.id).findLast((f) => f.rolle === 'ablehnung');
    res.render('abgelehnt', {
      job,
      abgelehntVonPerson,
      ablehnung,
      auditLog: buildAuditLog(db, job.id),
      kommentarBereich: kommentarBereich(db, config, req.currentPerson, job, `/abgelehnt/${job.id}`),
    });
  });

  // POST /abgelehnt/:id/ueberarbeiten – öffnet den Vorgang wieder (Status 'zugewiesen') und leitet in die Kontierung.
  router.post('/:id/ueberarbeiten', csrfProtection, (req, res) => {
    const job = loadAuthorizedJob(req, res);
    if (!job) return;
    // job.zugewiesen_an verwenden, nicht req.currentPerson.churchtools_person_id: Der Schutz von wiederOeffnenJob verlangt, dass zugewiesen_an zur
    // übergebenen Person passt, und für einen Portal-Admin, der über den Zweig freigabe1_eskaliert_an_admin berechtigt ist, ist die eigene ID des Admins nie gleich
    // job.zugewiesen_an (weiterhin die ID der ausgeschlossenen Stellvertretung 1) — mit der Admin-ID würde keine Zeile getroffen und trotzdem die allgemeine 409
    // wie bei einem Wettlauf geliefert. Für den normalen (Nicht-Admin-)Weg ist es per Definition identisch, da loadAuthorizedJob schon geprüft hat, dass
    // job.zugewiesen_an === req.currentPerson.churchtools_person_id, um hierher zu kommen. Entspricht der identischen Korrektur an der Route "zurück in den Pool"
    // in kontierung.js (Batch 3).
    const reopened = wiederOeffnenJob(db, job.id, job.zugewiesen_an);
    if (!reopened) {
      return res.status(409).render('error', { message: 'Diese Rechnung wurde inzwischen bereits von einem anderen Vorgang bearbeitet.' });
    }
    res.redirect(`/kontierung/${job.id}`);
  });

  return router;
}
