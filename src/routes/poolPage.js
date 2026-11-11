// Dashboard / Aufgabenseite `/pool` (docs/rechnungs-workflow.md): für jede angemeldete Person die eigenen Aufgaben (Kontierungen, Freigaben, Spesen-Freigaben, Überarbeitungen, Rapporte),
// für Buchhaltung/Superadmin zusätzlich der Pool der unzugewiesenen Vorgänge und für Superadmins die an die Administration eskalierten Vorgänge. Dazu zwei Aktionen auf Pool-Vorgängen
// (Zuweisen an eine Person, als Kreditkartenabrechnung markieren).

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
import { getKontoById, listKonten, listPersonenMitFreigeberRolle } from '../db/kontenRepo.js';
import { getKreditkarteById, listKreditkarten } from '../db/kreditkartenRepo.js';
import { buildSignedDownloadUrl, PDF_PREVIEW_TTL_SECONDS } from '../services/downloadUrl.js';
import { personHasRole } from '../middleware/roles.js';
import { personHasPermission, requirePermission } from '../middleware/permissions.js';
import { getConfigValue } from '../db/adminConfigRepo.js';
import { createFreigabe } from '../db/freigabenRepo.js';
import { sendNotificationMitVertretung } from '../services/notify.js';
import { markiereAlsKkAbrechnung } from '../services/kkMarkierung.js';
import { personName } from '../services/auditLog.js';
import { kommentarInfoFuer } from '../services/kommentare.js';
import { listOffeneRapporteForPerson } from '../db/rapporteRepo.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

export function createPoolPageRouter({ db, config, mailer, csrfProtection = (req, res, next) => next() }) {
  const router = Router();

  // Ergänzt Vorgänge um Vorschau-Adresse (signiert), Kontonummer, Hinweis-Konto und Namen der zurücksendenden Person.
  function enrich(jobs) {
    return jobs.map((job) => ({
      ...job,
      previewUrl: buildSignedDownloadUrl(config, job.id, PDF_PREVIEW_TTL_SECONDS),
      kontonummer: job.konto_id ? (getKontoById(db, job.konto_id)?.kontonummer ?? null) : null,
      // Nur sinnvoll, solange der Vorgang noch unzugewiesen im Pool liegt — sobald er tatsächlich kontiert ist, übernimmt das echte Konto (oben), und dieser Best-Effort-Hinweis ist hinfällig.
      hinweisKonto: job.hinweis_konto_id ? (getKontoById(db, job.hinweis_konto_id) ?? null) : null,
      rueckgesendetVonName: job.pool_rueckgesendet_von ? personName(db, job.pool_rueckgesendet_von) : null,
    }));
  }

  // GET /pool – das Dashboard (siehe Kopfkommentar).
  router.get('/', (req, res) => {
    const personId = req.currentPerson.churchtools_person_id;
    // /pool ist jetzt für jede angemeldete Person erreichbar (siehe app.js), aber der firmenweite Pool unzugewiesener Rechnungen bleibt Sache von Buchhaltung/Portal-Admin — die Abfrage
    // wird für alle anderen ganz übersprungen, statt sich allein darauf zu verlassen, dass pool.ejs ihn ausblendet.
    const zeigtPool = personHasRole(req.currentPerson, config, 'buchhaltung') || personHasRole(req.currentPerson, config, 'superadmin');
    const istSuperadmin = personHasRole(req.currentPerson, config, 'superadmin');
    const kannZuweisen = personHasPermission(db, config, req.currentPerson, 'pool_zuweisen');
    const daten = {
      poolJobs: zeigtPool ? enrich(listPoolJobs(db)) : [],
      kkKarten: zeigtPool && getConfigValue(db, 'modul_kreditkarten_aktiv') === '1' ? listKreditkarten(db) : [],
      ruecklaeufer: kannZuweisen ? enrich(listPoolRuecklaeufer(db)) : [],
      kannZuweisen,
      zielPersonen: kannZuweisen ? listPersonenMitFreigeberRolle(db) : [],
      meineKontierungen: enrich(listZugewiesenJobsForPerson(db, personId)),
      meineSpesenFreigaben: enrich(listSpesenFreigabe1JobsForPerson(db, personId)),
      meineFreigaben: enrich(listFreigabe2JobsForPerson(db, personId)),
      meineAbgelehnten: enrich(listAbgelehntJobsForPerson(db, personId)),
      // Rapporte nur zur Kenntnis: nur die genannte Person selbst, keine Ferienvertretung.
      meineRapporte: enrich(listOffeneRapporteForPerson(db, personId)),
      adminEskalierteKontierungen: istSuperadmin ? enrich(listAdminEskalierteKontierungen(db)) : [],
      adminEskalierteFreigaben: istSuperadmin ? enrich(listAdminEskalierteFreigaben(db)) : [],
      adminEskalierteSpesenFreigaben: istSuperadmin ? enrich(listAdminEskalierteSpesenFreigaben(db)) : [],
    };
    // Eine Abfrage für alle Listen der Seite (Anzahl/neu je Vorgang). Pool-Vorgänge (Pool und
    // Rückläufer, beide unzugewiesen) bekommen keine Marke: keine Seite, die der Pool verlinkt, zeigt
    // ihre Kommentare, das "neu" bliebe also bis zur Übernahme stehen (Abschlussprüfung 6).
    // Das Konto-Dropdown des Pool-Dialogs wird nur gebraucht, wenn es Kontierungen zum Zurücklegen gibt.
    daten.alleKonten = daten.meineKontierungen.length > 0 ? listKonten(db) : [];
    const listen = [daten.meineKontierungen, daten.meineSpesenFreigaben, daten.meineFreigaben, daten.meineAbgelehnten, daten.meineRapporte, daten.adminEskalierteKontierungen, daten.adminEskalierteFreigaben, daten.adminEskalierteSpesenFreigaben];
    daten.kommentarInfo = kommentarInfoFuer(db, config, req.currentPerson, listen.flat().map((j) => j.id));
    // Für den Aufgabenzähler der Navigation (middleware/nav.js): dieselben Listen wie
    // zaehleOffeneAufgaben, hier schon geladen. Admin-Listen sind ohne Superadmin leer.
    res.locals.offeneAufgabenVorab = daten.meineKontierungen.length + daten.meineFreigaben.length
      + daten.meineSpesenFreigaben.length + daten.meineRapporte.length + daten.adminEskalierteKontierungen.length
      + daten.adminEskalierteFreigaben.length + daten.adminEskalierteSpesenFreigaben.length;
    res.render('pool', daten);
  });

  // POST /pool/:id/zuweisen (Recht `pool_zuweisen`) – weist einen Pool-Vorgang ohne Kontierung einer Person mit Freigeber-Rolle zu (Verlaufseintrag 'pool_zuweisung', Mail mit Vertretung).
  router.post('/:id/zuweisen', requirePermission(db, config, 'pool_zuweisen'), csrfProtection, asyncHandler(async (req, res, next) => {
    try {
      const job = getJobById(db, Number(req.params.id));
      // quelle === 'spesen' entspricht dem Ausschluss, den listPoolJobs/listPoolRuecklaeufer oben schon anwenden — eine Spesenposition erscheint in keiner der beiden Pool-Listen, diese Route soll
      // sie also auch nie erreichen. Über die Oberfläche nicht erreichbar, aber eine von Hand gebaute Anfrage könnte per id direkt eine ansteuern, daher eine zusätzliche Absicherung neben der Statusprüfung.
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
      await sendNotificationMitVertretung(db, mailer, {
        person: zielPerson,
        typ: 'zuweisung',
        jobId: job.id,
        variablen: {
          jobDateiname: job.dateiname,
          grund: `Eine Rechnung wurde dir von ${req.currentPerson.vorname} ${req.currentPerson.nachname} zur Kontierung zugewiesen.`,
          link: `${config.publicBaseUrl}/kontierung/${job.id}`,
        },
      });
      res.json({ id: job.id, status: 'zugewiesen' });
    } catch (err) {
      next(err);
    }
  }));

  // POST /pool/:id/als-kk-abrechnung – markiert einen Pool-Vorgang als Abrechnung einer Kreditkarte (nur Buchhaltung/Superadmin, nur bei aktivem Modul).
  router.post('/:id/als-kk-abrechnung', csrfProtection, asyncHandler(async (req, res, next) => {
    try {
      const darf = personHasRole(req.currentPerson, config, 'buchhaltung') || personHasRole(req.currentPerson, config, 'superadmin');
      if (!darf || getConfigValue(db, 'modul_kreditkarten_aktiv') !== '1') {
        return res.status(403).render('error', { message: 'Du darfst diese Aktion nicht ausführen.' });
      }
      const job = getJobById(db, Number(req.params.id));
      const karte = getKreditkarteById(db, Number(req.body.kreditkarteId));
      if (!job || job.status !== 'unzugewiesen' || job.quelle === 'spesen') {
        return res.status(409).render('error', { message: 'Der Beleg ist nicht mehr im Pool verfügbar.' });
      }
      if (!karte || !karte.aktiv) return res.status(400).render('error', { message: 'Bitte eine gültige Karte wählen.' });
      const ok = await markiereAlsKkAbrechnung(db, config, mailer, { job, karte, markiertVon: req.currentPerson, ip: req.ip, ausStatus: 'unzugewiesen' });
      if (!ok) return res.status(409).render('error', { message: 'Der Beleg ist nicht mehr im Pool verfügbar.' });
      res.redirect(karte.verantwortlich_id === req.currentPerson.churchtools_person_id ? `/kontierung/${job.id}/kk-abgleich` : '/pool');
    } catch (err) {
      next(err);
    }
  }));

  return router;
}
