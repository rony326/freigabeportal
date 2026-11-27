// Admin → Abgelehnte Rechnungen (`/admin/abgelehnt`, Recht `abgelehnt_verwalten`, docs/admin-bereich.md): Liste aller abgelehnten Vorgänge, «Zurück in den Pool»
// (Neustart ohne Überarbeitung; nicht für Spesen und Kreditkartenabrechnungen) und endgültiges (weiches) Löschen, beides mit Begründung. Wer eine Rechnung selbst abgelehnt
// hat, darf sie nicht löschen; in den Pool zurücklegen darf er sie, weil das umkehrbar ist. Mount: app.js unter /admin/abgelehnt.

import { Router } from 'express';
import { getJobById, listAlleAbgelehntenJobs, loeschenJob, forceReleaseJob } from '../../db/jobsRepo.js';
import { createFreigabe } from '../../db/freigabenRepo.js';
import { sendNotification } from '../../services/notify.js';
import { MIN_BEMERKUNG_LAENGE } from '../../services/vorgangUmhaengen.js';
import { leseText, MAX_LAENGE } from '../../utils/eingabe.js';
import { getPersonById } from '../../db/personenRepo.js';
import { logJobLoeschung } from '../../db/jobLoeschungenRepo.js';
import { kommentarInfoFuer } from '../../services/kommentare.js';
import { pruefeUndFinalisiereSplitGruppe } from '../../services/splitGruppenExport.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';

export function createAdminAbgelehntRouter({ db, config, mailer = null, csrfProtection = (req, res, next) => next() }) {
  const router = Router();

  // GET /admin/abgelehnt – Liste.
  router.get('/', (req, res) => {
    const jobs = listAlleAbgelehntenJobs(db).map((job) => ({
      ...job,
      abgelehntVonPerson: getPersonById(db, job.abgelehnt_von),
    }));
    res.render('admin/abgelehnt-liste', { jobs, kommentarInfo: kommentarInfoFuer(db, config, req.currentPerson, jobs.map((j) => j.id)), gespeichert: req.query.gespeichert === '1', imPool: req.query.pool === '1' });
  });

  // Zurück in den Pool (Rückmeldung 2026-11-27): Die Administration bringt eine abgelehnte Rechnung wieder in Umlauf,
  // ohne dass die zugewiesene Person sie zuerst überarbeiten muss. Echter Neustart wie die Pool-Rückgabe aus der
  // Kontierung (forceReleaseJob: Konto, Zuweisung, Eskalationen und Ablehnung werden zurückgesetzt). Spesen sind
  // ausgenommen — eine abgelehnte Spesenposition ist endgültig und hätte im Pool keine Prüfseite.
  function ladePoolKandidat(req, res) {
    const job = getJobById(db, Number(req.params.id));
    if (!job || job.status !== 'abgelehnt') {
      res.status(404).render('error', { message: 'Diese Rechnung ist nicht (mehr) abgelehnt oder existiert nicht.' });
      return null;
    }
    if (job.quelle === 'spesen') {
      res.status(409).render('error', { message: 'Abgelehnte Spesen-Positionen sind endgültig und können nicht in den Pool zurückgelegt werden.' });
      return null;
    }
    // Wie bei der Pool-Rückgabe aus der Kontierung: Kreditkartenabrechnungen laufen über den Abgleich.
    if (job.kreditkarte_id) {
      res.status(409).render('error', { message: 'Diese Abrechnung ist einer Kreditkarte zugeordnet und wird über den Abgleich bearbeitet.' });
      return null;
    }
    return job;
  }

  // Wer bekommt nach «Zurück in den Pool» eine Mail? Gilt für den Versand und die Ankündigung auf der Bestätigungsseite.
  function wirdInformiert(bisher, admin) {
    return Boolean(mailer && bisher && bisher.aktiv && bisher.churchtools_person_id !== admin.churchtools_person_id);
  }

  function zeigePoolSeite(req, res, status, job, errors, begruendung) {
    const bisher = getPersonById(db, job.zugewiesen_an);
    res.status(status).render('admin/abgelehnt-pool', {
      job, errors, begruendung, maxLen: MAX_LAENGE, minLaenge: MIN_BEMERKUNG_LAENGE, bisher, mailAngekuendigt: wirdInformiert(bisher, req.currentPerson),
    });
  }

  // GET /admin/abgelehnt/:id/pool – Bestätigungsseite mit Begründung.
  router.get('/:id/pool', (req, res) => {
    const job = ladePoolKandidat(req, res);
    if (!job) return;
    zeigePoolSeite(req, res, 200, job, [], '');
  });

  // POST /admin/abgelehnt/:id/pool – legt die Rechnung zurück in den Pool (Verlaufseintrag + Audit), informiert die bisher zuständige Person.
  router.post('/:id/pool', csrfProtection, asyncHandler(async (req, res) => {
    const job = ladePoolKandidat(req, res);
    if (!job) return;
    const gelesen = leseText(req.body.begruendung, { max: MAX_LAENGE.text, feld: 'Begründung' });
    const begruendung = gelesen.wert || '';
    const bisher = getPersonById(db, job.zugewiesen_an);
    const fehler = gelesen.fehler || (begruendung.length < MIN_BEMERKUNG_LAENGE ? `Bitte eine Begründung mit mindestens ${MIN_BEMERKUNG_LAENGE} Zeichen angeben.` : null);
    if (fehler) {
      return zeigePoolSeite(req, res, 400, job, [fehler], begruendung);
    }
    const admin = req.currentPerson;
    const adminName = `${admin.vorname} ${admin.nachname}`;
    db.exec('BEGIN');
    try {
      if (!forceReleaseJob(db, job.id)) {
        db.exec('ROLLBACK');
        return res.status(409).render('error', { message: 'Diese Rechnung wurde inzwischen bereits anderweitig bearbeitet.' });
      }
      const zeitpunkt = new Date().toISOString();
      createFreigabe(db, {
        jobId: job.id,
        personId: admin.churchtools_person_id,
        rolle: 'admin_umzuweisung',
        zeitpunkt,
        ip: req.ip,
        interessenskonflikt: false,
        kommentar: `Abgelehnte Rechnung zurück in den Pool gelegt: ${begruendung}`,
        eskaliertVon: null,
        vorherZustaendig: job.zugewiesen_an,
      });
      db.prepare(`INSERT INTO audit_ereignisse
        (zeitpunkt, person_id, person_name, objekt, objekt_id, aktion, begruendung)
        VALUES (?, ?, ?, 'jobs', ?, 'workflow_eingriff', ?)`).run(
        zeitpunkt, admin.churchtools_person_id, adminName, String(job.id), `Abgelehnte Rechnung zurück in den Pool: ${begruendung}`);
      db.exec('COMMIT');
    } catch (err) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw err;
    }
    if (wirdInformiert(bisher, admin)) {
      await sendNotification(db, mailer, {
        to: bisher.email,
        typ: 'admin-umzuweisung',
        jobId: job.id,
        variablen: {
          empfaengerName: `${bisher.vorname} ${bisher.nachname}`,
          jobDateiname: job.dateiname,
          adminName,
          bemerkung: begruendung,
          grund: `${adminName} hat eine abgelehnte Rechnung, die bei dir zur Überarbeitung lag, zurück in den Pool gelegt. Du musst dafür nichts mehr tun.`,
          link: `${config.publicBaseUrl}/pool`,
        },
      });
    }
    res.redirect('/admin/abgelehnt?pool=1');
  }));

  // GET /admin/abgelehnt/:id – Bestätigungsseite zum Löschen (403 bei Selbstablehnung).
  router.get('/:id', (req, res) => {
    const job = getJobById(db, Number(req.params.id));
    if (!job || job.status !== 'abgelehnt') {
      return res.status(404).render('error', { message: 'Diese Rechnung ist nicht (mehr) abgelehnt oder existiert nicht.' });
    }
    if (job.abgelehnt_von === req.currentPerson.churchtools_person_id) {
      return res.status(403).render('error', { message: 'Du hast diese Rechnung selbst abgelehnt und kannst sie daher nicht selbst löschen.' });
    }
    res.render('admin/abgelehnt-loeschen', { job, errors: [], begruendung: '' });
  });

  // POST /admin/abgelehnt/:id/loeschen – löscht weich (Status 'geloescht', Eintrag in job_loeschungen) und stösst bei einem Splitkind die Prüfung der Gruppe an.
  router.post('/:id/loeschen', csrfProtection, asyncHandler(async (req, res, next) => {
    try {
      const job = getJobById(db, Number(req.params.id));
      if (!job || job.status !== 'abgelehnt') {
        return res.status(404).render('error', { message: 'Diese Rechnung ist nicht (mehr) abgelehnt oder existiert nicht.' });
      }
      if (job.abgelehnt_von === req.currentPerson.churchtools_person_id) {
        return res.status(403).render('error', { message: 'Du hast diese Rechnung selbst abgelehnt und kannst sie daher nicht selbst löschen.' });
      }

      const { begruendung, bestaetigung } = req.body;
      const errors = [];
      if (!begruendung || !begruendung.trim()) {
        errors.push('Eine Begründung ist Pflicht.');
      }
      if (bestaetigung !== 'ja') {
        errors.push('Bitte die Löschung bestätigen.');
      }
      if (errors.length > 0) {
        return res.status(400).render('admin/abgelehnt-loeschen', { job, errors, begruendung: begruendung || '' });
      }

      db.exec('BEGIN');
      let geloescht;
      try {
        geloescht = loeschenJob(db, job.id);
        if (geloescht) {
          logJobLoeschung(db, {
            jobId: geloescht.id,
            dateiname: geloescht.dateiname,
            geloeschtVon: req.currentPerson.churchtools_person_id,
            begruendung: begruendung.trim(),
          });
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }

      if (!geloescht) {
        return res.status(409).render('error', { message: 'Diese Rechnung wurde inzwischen bereits anderweitig bearbeitet (z.B. überarbeitet).' });
      }

      if (geloescht.aufgesplittet_von) {
        try {
          await pruefeUndFinalisiereSplitGruppe(db, geloescht.aufgesplittet_von, config, { spur: 'interaktiv' });
        } catch (err) {
          console.error(`Splitgruppen-Prüfung für Elternjob ${geloescht.aufgesplittet_von} fehlgeschlagen:`, err.message);
        }
      }

      res.redirect('/admin/abgelehnt?gespeichert=1');
    } catch (err) {
      next(err);
    }
  }));

  return router;
}
