import { Router } from 'express';
import multer from 'multer';
import { detectBelegMimetype, countBelegSeiten } from '../services/belegAnhaengen.js';
import {
  setKontierung,
  updateKontierungMetadaten,
  ablehnenJob,
  eskalierenFreigabe1,
  eskalierenFreigabe1AnAdmin,
  abschliessenFreigabe1,
  weiterleitenAnEchtenFreigeber1,
  releaseJob,
  getEffectiveFreigeber2Id,
  markJobAufgesplittet,
  setJobBetrag,
  addBelegSeiten,
  findJobsByDebitorUndRechnungsnummer,
  sendJobBackToGroup,
  hebeKkMarkierungAuf,
} from '../db/jobsRepo.js';
import { getKontoById, listKonten } from '../db/kontenRepo.js';
import { listDebitoren, getDebitorById, createDebitor } from '../db/debitorenRepo.js';
import { findDebitorIbanByIban, createDebitorIban } from '../db/debitorIbanRepo.js';
import { getKreditkarteById, listKreditkarten } from '../db/kreditkartenRepo.js';
import { createFreigabe } from '../db/freigabenRepo.js';
import { buildSignedDownloadUrl, PDF_PREVIEW_TTL_SECONDS } from '../services/downloadUrl.js';
import { getPersonById } from '../db/personenRepo.js';
import { sendNotification, sendNotificationMitVertretung, resolveEmpfaenger } from '../services/notify.js';
import { istAktiveVertretungFuer } from '../services/vertretung.js';
import { buildAuditLog } from '../services/auditLog.js';
import { getConfigValue } from '../db/adminConfigRepo.js';
import { isValidIban } from '../services/ibanUtils.js';
import { ladeKontierbarenJob, ladeKontenFuerJob as ladeKontenFuerJobService } from '../services/kontierungZugriff.js';
import { markiereAlsKkAbrechnung } from '../services/kkMarkierung.js';
import {
  POSITION_PATTERN,
  mergeBelegFuerJob,
  pruefeIbanAbgleich,
  bereiteTeilDateienVor,
  erzeugeTeilJobs,
  benachrichtigeNachAufsplitten,
  pruefeIbanNachAufsplitten,
} from '../services/aufsplitten.js';

const BETRAG_PATTERN = /^\d+([.,]\d{1,2})?$/;
const ZAHLUNGSZIEL_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_BELEG_SIZE = 20 * 1024 * 1024;
// Aufsplitten sends one optional beleg file per Teil row (teilBeleg_<i>) via uploadBeleg.any(),
// which has no field-name allowlist — without a files cap, a request forging many parts could
// force up to fileSize each into memory. No real form has anywhere near this many Teile.
const MAX_BELEG_FILES = 25;

const uploadBeleg = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BELEG_SIZE, files: MAX_BELEG_FILES },
});

function buildQrInfo(db, job) {
  if (!job.qr_erkannt_am) return null;
  const ibanMapping = job.qr_iban ? findDebitorIbanByIban(db, job.qr_iban) : null;
  const vorschlagDebitor = ibanMapping ? getDebitorById(db, ibanMapping.debitor_id) : null;
  const debitorFuerAbgleich = job.debitor_id ? getDebitorById(db, job.debitor_id) : vorschlagDebitor;
  const abgleich = job.qr_iban && debitorFuerAbgleich ? pruefeIbanAbgleich(db, debitorFuerAbgleich.id, job.qr_iban) : null;
  const konfliktMitZugewiesenemDebitor = Boolean(vorschlagDebitor) && Boolean(job.debitor_id) && vorschlagDebitor.id !== job.debitor_id;
  return {
    iban: job.qr_iban,
    referenz: job.qr_referenz,
    betrag: job.qr_betrag,
    waehrung: job.qr_waehrung,
    creditorName: job.qr_creditor_name,
    vorschlagDebitor,
    // Only meaningful (and only resolved) when there's actually a conflict to name — debitorFuerAbgleich
    // already IS the currently-assigned debitor in that case, since job.debitor_id is truthy whenever
    // konfliktMitZugewiesenemDebitor is true.
    zugewiesenerDebitor: konfliktMitZugewiesenemDebitor ? debitorFuerAbgleich : null,
    debitorFuerAbgleich,
    konfliktMitZugewiesenemDebitor,
    abgleich,
  };
}

export function createKontierungRouter({ db, config, mailer, csrfProtection = (req, res, next) => next() }) {
  const router = Router();

  const loadAuthorizedJob = (req, res) => ladeKontierbarenJob(db, config, req, res);
  const ladeKontenFuerJob = (req, job) => ladeKontenFuerJobService(db, req, job);

  function sperreKkAbrechnung(job, res) {
    if (!job.kreditkarte_id) return false;
    res.status(409).render('error', { message: 'Diese Abrechnung ist einer Kreditkarte zugeordnet und wird über den Abgleich bearbeitet.' });
    return true;
  }

  router.get('/:id', (req, res) => {
    const job = loadAuthorizedJob(req, res);
    if (!job) return;
    if (job.kreditkarte_id) return res.redirect(`/kontierung/${job.id}/kk-abgleich`);
    const konten = ladeKontenFuerJob(req, job);
    const qrInfo = buildQrInfo(db, job);
    res.render('kontierung', {
      job,
      konten,
      alleKonten: listKonten(db),
      debitoren: listDebitoren(db),
      kkKarten: getConfigValue(db, 'modul_kreditkarten_aktiv') === '1' ? listKreditkarten(db) : [],
      previewUrl: buildSignedDownloadUrl(config, job.id, PDF_PREVIEW_TTL_SECONDS),
      values: {
        kontoId: job.konto_id ? String(job.konto_id) : '',
        typ: job.typ || 'rechnung',
        interessenskonflikt: '',
        begruendung: '',
        absender: job.absender || '',
        betrag: job.betrag || (qrInfo ? qrInfo.betrag || '' : ''),
        zahlungsziel: job.zahlungsziel || '',
        rechnungsnummer: job.rechnungsnummer || '',
        debitorId: job.debitor_id ? String(job.debitor_id) : (qrInfo && qrInfo.vorschlagDebitor ? String(qrInfo.vorschlagDebitor.id) : ''),
      },
      qrInfo,
      errors: [],
      auditLog: buildAuditLog(db, job.id),
    });
  });

  // Must be registered before the generic /:id routes below — otherwise POST
  // /kontierung/lieferanten would first match /:id (with id="lieferanten", a NaN Number()) and
  // 404/403 before ever reaching this handler. Open to any logged-in Kontierung user (not just
  // Portal-Admins), since Kontierung itself is usually done by Buchhaltung, not admins — mirrors
  // the validation in POST /admin/debitoren, minus the admin-only gate.
  router.post('/lieferanten', csrfProtection, (req, res) => {
    const { name, kontoId } = req.body;
    const trimmedName = (name || '').trim();
    if (!trimmedName) {
      return res.status(400).json({ error: 'Name ist ein Pflichtfeld.' });
    }
    const id = createDebitor(db, { name: trimmedName, kontoId: kontoId ? Number(kontoId) : null });
    res.status(201).json({ id, name: trimmedName });
  });

  router.post('/:id', (req, res, next) => {
    uploadBeleg.single('beleg')(req, res, async (uploadErr) => {
    // csrfProtection runs after multer parses the multipart body (the _csrf field included) —
    // any earlier and req.body would still be empty, rejecting every legitimate submission.
    csrfProtection(req, res, async (csrfErr) => {
    if (csrfErr) return next(csrfErr);
    try {
      const job = loadAuthorizedJob(req, res);
      if (!job) return;
      if (sperreKkAbrechnung(job, res)) return;
      const konten = ladeKontenFuerJob(req, job);
      const debitoren = listDebitoren(db);
      const qrInfo = buildQrInfo(db, job);
      const { kontoId, interessenskonflikt, begruendung, absender, betrag, zahlungsziel, rechnungsnummer, debitorId, aktion, typ } = req.body;
      const jobTyp = typ === 'gutschrift' ? 'gutschrift' : 'rechnung';
      const values = { kontoId, interessenskonflikt, begruendung, absender, betrag, zahlungsziel, rechnungsnummer, debitorId, typ: jobTyp };

      const renderFehler = (messages, status = 400) =>
        res.status(status).render('kontierung', {
          job,
          konten,
          alleKonten: listKonten(db),
          debitoren,
          previewUrl: buildSignedDownloadUrl(config, job.id, PDF_PREVIEW_TTL_SECONDS),
          values,
          qrInfo,
          kkKarten: getConfigValue(db, 'modul_kreditkarten_aktiv') === '1' ? listKreditkarten(db) : [],
          errors: Array.isArray(messages) ? messages : [messages],
          auditLog: buildAuditLog(db, job.id),
        });

      if (uploadErr) {
        return renderFehler(uploadErr.code === 'LIMIT_FILE_SIZE' ? 'Der Beleg darf höchstens 20 MB gross sein.' : 'Fehler beim Datei-Upload.');
      }
      // Applies regardless of aktion (kontieren or ablehnen) — a Beleg attached alongside a
      // rejection is still merged, since the original PDF (with the Beleg now part of it) is
      // what gets reworked and resubmitted afterwards.
      let belegMimetype = null;
      if (req.file) {
        belegMimetype = detectBelegMimetype(req.file.buffer);
        if (!belegMimetype || belegMimetype !== req.file.mimetype) {
          return renderFehler('Beleg muss eine PDF-, PNG- oder JPEG-Datei sein.');
        }
      }

      if (aktion === 'ablehnen') {
        if (!begruendung) {
          return renderFehler('Bei einer Ablehnung ist eine Begründung Pflicht.');
        }

        db.exec('BEGIN');
        let abgelehnt;
        try {
          abgelehnt = ablehnenJob(db, job.id, { abgelehntVon: req.currentPerson.churchtools_person_id, grund: begruendung });
          if (abgelehnt) {
            createFreigabe(db, {
              jobId: job.id,
              personId: req.currentPerson.churchtools_person_id,
              rolle: 'ablehnung',
              zeitpunkt: new Date().toISOString(),
              ip: req.ip,
              interessenskonflikt: false,
              kommentar: begruendung,
              eskaliertVon: null,
              vertretungFuer: !job.freigabe1_eskaliert_an_admin && istAktiveVertretungFuer(db, req.currentPerson.churchtools_person_id, job.zugewiesen_an) ? job.zugewiesen_an : null,
            });
          }
          db.exec('COMMIT');
        } catch (err) {
          db.exec('ROLLBACK');
          throw err;
        }

        if (!abgelehnt) {
          return renderFehler('Diese Rechnung wurde inzwischen bereits von einem anderen Vorgang bearbeitet.', 409);
        }

        // beleg_seitenzahl mitzuführen ist hier genauso Pflicht wie beim Aufsplitten: auch ein
        // Splitkind (aufgesplittet_von gesetzt) landet auf diesem Pfad, wenn seine Zeile abgelehnt
        // und überarbeitet wird. Ohne die Fortschreibung wüsste der spätere Gruppen-Merge nichts
        // von diesen Belegseiten und liesse sie kommentarlos aus dem Archivdokument weg.
        // Bewusst nicht auf Splitkinder eingeschränkt -- bei einem gewöhnlichen Job liest diese
        // Spalte schlicht niemand.
        if (req.file) {
          // Merge first, count second: if mergeBelegFuerJob throws (e.g. a truncated-but-
          // well-signed image that only fails inside embedPng), beleg_seitenzahl must not have
          // already been incremented for pages that were never actually written -- an inflated
          // count later makes haengeBelegSeitenAn's slice over-reach into the child's own
          // Freigabe-2 Stempelseite, corrupting the archival document silently.
          await mergeBelegFuerJob(job.pdf_pfad, req.file, belegMimetype);
          addBelegSeiten(db, job.id, await countBelegSeiten(req.file.buffer, belegMimetype));
        }

        if (job.freigabe1_eskaliert_an_admin) {
          const empfaenger = resolveEmpfaenger(db, config, 'gruppe:admin');
          for (const email of empfaenger) {
            await sendNotification(db, mailer, {
              to: email,
              typ: 'ablehnung',
              jobId: job.id,
              variablen: {
                empfaengerName: 'Portal-Admin-Team',
                jobDateiname: job.dateiname,
                grund: 'Eine an die Portal-Admin-Gruppe eskalierte Rechnung wurde abgelehnt:',
                begruendung,
                link: `${config.publicBaseUrl}/abgelehnt/${job.id}`,
              },
            });
          }
        }

        return res.redirect('/pool');
      }

      const errors = [];

      const konto = konten.find((k) => String(k.id) === kontoId);
      if (!konto) {
        errors.push('Bitte ein gültiges Konto aus der Liste auswählen.');
      }
      if (!absender) {
        errors.push('Bitte einen Absender angeben.');
      }
      const debitor = debitorId ? getDebitorById(db, debitorId) : null;
      if (!debitor) {
        errors.push('Bitte einen gültigen Lieferanten aus der Liste auswählen.');
      }
      if (!rechnungsnummer) {
        errors.push('Bitte eine Rechnungsnummer angeben.');
      }
      const hatKonflikt = interessenskonflikt === 'ja';
      if (hatKonflikt && !begruendung) {
        errors.push('Bei einem Interessenskonflikt ist eine Begründung Pflicht.');
      }
      if (!betrag) {
        errors.push('Bitte einen Betrag angeben.');
      } else if (!BETRAG_PATTERN.test(betrag)) {
        errors.push('Betrag muss eine gültige Zahl sein (z.B. 123.45).');
      }
      // Eine Gutschrift hat kein Fälligkeitsdatum im eigentlichen Sinn — nur bei einer Rechnung
      // ist das Zahlungsziel Pflicht; ein trotzdem mitgegebener Wert wird aber weiterhin geprüft.
      if (!zahlungsziel) {
        if (jobTyp === 'rechnung') {
          errors.push('Bitte ein Zahlungsziel angeben.');
        }
      } else if (!ZAHLUNGSZIEL_PATTERN.test(zahlungsziel) || Number.isNaN(new Date(zahlungsziel).getTime())) {
        errors.push('Zahlungsziel ist kein gültiges Datum.');
      }

      if (errors.length > 0) {
        return renderFehler(errors);
      }

      // SYNC-8: a conflict-driven escalation has no distinct named person to hand off to in two
      // cases — this job was already escalated once (so the only person who could even reach
      // this line, per loadAuthorizedJob, is the previously-escalated Stellvertreter1, and they
      // ALSO have a conflict), or the chosen Konto's stellvertreter1 IS the current person
      // (escalating would target themselves). Both route to the Portal-Admin group instead of
      // blocking with the old "go back to pool / contact admin" dead end.
      const eskaliertAnAdmin = hatKonflikt && Boolean(job.freigabe1_eskaliert_von || konto.stellvertreter1_id === req.currentPerson.churchtools_person_id);
      const strikteFreigeber1Pruefung = getConfigValue(db, 'kontierung_strikte_freigeber1_pruefung') === '1';
      const istEchterFreigeber1 =
        konto.freigeber1_id === req.currentPerson.churchtools_person_id ||
        istAktiveVertretungFuer(db, req.currentPerson.churchtools_person_id, konto.freigeber1_id) ||
        (Boolean(job.freigabe1_eskaliert_von) && konto.stellvertreter1_id === req.currentPerson.churchtools_person_id);
      const wirdWeitergeleitet = !hatKonflikt && !eskaliertAnAdmin && strikteFreigeber1Pruefung && !job.freigabe1_eskaliert_an_admin && !istEchterFreigeber1;

      db.exec('BEGIN');
      try {
        setKontierung(db, job.id, konto.id);
        updateKontierungMetadaten(db, job.id, {
          absender,
          betrag: betrag ? betrag.replace(',', '.') : null,
          zahlungsziel,
          rechnungsnummer,
          lieferant: debitor ? debitor.name : null,
          debitorId: debitor ? debitor.id : null,
          typ: jobTyp,
        });
        if (eskaliertAnAdmin) {
          createFreigabe(db, {
            jobId: job.id,
            personId: req.currentPerson.churchtools_person_id,
            rolle: 'freigabe1_eskalation',
            zeitpunkt: new Date().toISOString(),
            ip: req.ip,
            interessenskonflikt: true,
            kommentar: begruendung,
            eskaliertVon: job.freigabe1_eskaliert_von,
          });
          eskalierenFreigabe1AnAdmin(db, job.id, { eskaliertVon: req.currentPerson.churchtools_person_id, grund: begruendung });
        } else if (hatKonflikt) {
          createFreigabe(db, {
            jobId: job.id,
            personId: req.currentPerson.churchtools_person_id,
            rolle: 'freigabe1_eskalation',
            zeitpunkt: new Date().toISOString(),
            ip: req.ip,
            interessenskonflikt: true,
            kommentar: begruendung,
            eskaliertVon: job.freigabe1_eskaliert_von,
          });
          eskalierenFreigabe1(db, job.id, { eskaliertVon: req.currentPerson.churchtools_person_id, grund: begruendung, stellvertreterId: konto.stellvertreter1_id });
        } else if (wirdWeitergeleitet) {
          weiterleitenAnEchtenFreigeber1(db, job.id, konto.freigeber1_id);
          createFreigabe(db, { jobId: job.id, personId: req.currentPerson.churchtools_person_id, rolle: 'freigabe1_weiterleitung', zeitpunkt: new Date().toISOString(), ip: req.ip, interessenskonflikt: false, kommentar: begruendung || null, eskaliertVon: job.freigabe1_eskaliert_von });
        } else {
          createFreigabe(db, {
            jobId: job.id,
            personId: req.currentPerson.churchtools_person_id,
            rolle: 'freigeber1',
            zeitpunkt: new Date().toISOString(),
            ip: req.ip,
            interessenskonflikt: false,
            kommentar: begruendung || null,
            eskaliertVon: job.freigabe1_eskaliert_von,
            vertretungFuer: !job.freigabe1_eskaliert_an_admin && istAktiveVertretungFuer(db, req.currentPerson.churchtools_person_id, job.zugewiesen_an) ? job.zugewiesen_an : null,
          });
          abschliessenFreigabe1(db, job.id);
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }

      // Siehe Ablehnungs-Pfad oben: ein Splitkind erreicht auch die normale Kontierung -- etwa
      // eine per hinweis_konto_id angelegte Zeile, die aus dem Pool geclaimt wird, oder eine aus
      // der Interessenskonflikt-Eskalationsmail heraus geöffnete. Ein hier angehängter Beleg muss
      // deshalb genauso in beleg_seitenzahl einfliessen, sonst fehlt er später im Gruppendokument.
      if (req.file) {
        // Merge first, count second -- see the identical comment at the Ablehnungs-Pfad above.
        await mergeBelegFuerJob(job.pdf_pfad, req.file, belegMimetype);
        addBelegSeiten(db, job.id, await countBelegSeiten(req.file.buffer, belegMimetype));
      }

      if (job.qr_iban && debitor) {
        const { status } = pruefeIbanAbgleich(db, debitor.id, job.qr_iban);
        if (status === 'mismatch') {
          createFreigabe(db, {
            jobId: job.id,
            personId: req.currentPerson.churchtools_person_id,
            rolle: 'iban_abweichung',
            zeitpunkt: new Date().toISOString(),
            ip: req.ip,
            interessenskonflikt: false,
            kommentar: `QR-IBAN ${job.qr_iban} weicht von der/den für ${debitor.name} hinterlegten IBAN(s) ab.`,
            eskaliertVon: null,
          });
          const zusatzEmpfaenger = new Set(resolveEmpfaenger(db, config, getConfigValue(db, 'iban_abweichung_empfaenger')));
          zusatzEmpfaenger.add(req.currentPerson.email);
          const freigeber1 = getPersonById(db, konto.freigeber1_id);
          const freigeber2 = getPersonById(db, konto.freigeber2_id);
          if (freigeber1) zusatzEmpfaenger.add(freigeber1.email);
          if (freigeber2) zusatzEmpfaenger.add(freigeber2.email);
          for (const email of zusatzEmpfaenger) {
            await sendNotification(db, mailer, {
              to: email,
              typ: 'iban-warnung',
              jobId: job.id,
              variablen: {
                jobDateiname: job.dateiname,
                debitorName: debitor.name,
                tatsaechlicheIban: job.qr_iban,
                link: `${config.publicBaseUrl}/kontierung/${job.id}`,
              },
            });
          }
        } else if (
          status === 'kein_abgleich' &&
          req.body.ibanMerken === 'on' &&
          isValidIban(job.qr_iban) &&
          !findDebitorIbanByIban(db, job.qr_iban)
        ) {
          createDebitorIban(db, { debitorId: debitor.id, iban: job.qr_iban, quelle: 'bestaetigt' });
        }
      }

      if (debitor) {
        const duplikate = findJobsByDebitorUndRechnungsnummer(db, debitor.id, rechnungsnummer, job.id);
        if (duplikate.length > 0) {
          createFreigabe(db, {
            jobId: job.id,
            personId: req.currentPerson.churchtools_person_id,
            rolle: 'rechnungsnummer_duplikat',
            zeitpunkt: new Date().toISOString(),
            ip: req.ip,
            interessenskonflikt: false,
            kommentar: `Rechnungsnummer "${rechnungsnummer}" ist bei ${debitor.name} bereits erfasst: Job ${duplikate.map((d) => `#${d.id}`).join(', ')}.`,
            eskaliertVon: null,
          });
          const zusatzEmpfaenger = new Set([req.currentPerson.email]);
          const freigeber1 = getPersonById(db, konto.freigeber1_id);
          const freigeber2 = getPersonById(db, konto.freigeber2_id);
          if (freigeber1) zusatzEmpfaenger.add(freigeber1.email);
          if (freigeber2) zusatzEmpfaenger.add(freigeber2.email);
          for (const email of zusatzEmpfaenger) {
            await sendNotification(db, mailer, {
              to: email,
              typ: 'rechnungsnummer-warnung',
              jobId: job.id,
              variablen: {
                jobDateiname: job.dateiname,
                debitorName: debitor.name,
                rechnungsnummer,
                dupJobIds: duplikate.map((d) => `#${d.id}`).join(', '),
                link: `${config.publicBaseUrl}/kontierung/${job.id}`,
              },
            });
          }
        }
      }

      if (eskaliertAnAdmin) {
        const empfaenger = resolveEmpfaenger(db, config, 'gruppe:admin');
        for (const email of empfaenger) {
          await sendNotification(db, mailer, {
            to: email,
            typ: 'zuweisung',
            jobId: job.id,
            variablen: {
              empfaengerName: 'Portal-Admin-Team',
              jobDateiname: job.dateiname,
              grund: 'Eine Rechnung wurde an die Portal-Admin-Gruppe eskaliert, da auch die Stellvertretung einen Interessenskonflikt erklärt hat.',
              link: `${config.publicBaseUrl}/kontierung/${job.id}`,
            },
          });
        }
      } else if (hatKonflikt) {
        const stellvertreter1 = getPersonById(db, konto.stellvertreter1_id);
        if (stellvertreter1) {
          await sendNotification(db, mailer, {
            to: stellvertreter1.email,
            typ: 'zuweisung',
            jobId: job.id,
            variablen: {
              empfaengerName: `${stellvertreter1.vorname} ${stellvertreter1.nachname}`,
              jobDateiname: job.dateiname,
              grund: `Eine Rechnung wurde dir zur Kontierung übergeben, da ${req.currentPerson.vorname} ${req.currentPerson.nachname} einen Interessenskonflikt erklärt hat.`,
              link: `${config.publicBaseUrl}/kontierung/${job.id}`,
            },
          });
        }
      } else if (wirdWeitergeleitet) {
        const echterFreigeber1 = getPersonById(db, konto.freigeber1_id);
        if (echterFreigeber1) {
          await sendNotificationMitVertretung(db, mailer, {
            person: echterFreigeber1,
            typ: 'zuweisung',
            jobId: job.id,
            variablen: {
              jobDateiname: job.dateiname,
              grund: `Eine Rechnung wurde von ${req.currentPerson.vorname} ${req.currentPerson.nachname} kontiert und wartet auf deine Freigabe 1.`,
              link: `${config.publicBaseUrl}/kontierung/${job.id}`,
            },
          });
        }
      } else {
        const freigeber2 = getPersonById(db, getEffectiveFreigeber2Id(job, konto));
        if (freigeber2) {
          await sendNotificationMitVertretung(db, mailer, {
            person: freigeber2,
            typ: 'zuweisung',
            jobId: job.id,
            variablen: {
              jobDateiname: job.dateiname,
              grund: 'Eine Rechnung wartet auf deine Freigabe 2.',
              link: `${config.publicBaseUrl}/freigabe2/${job.id}`,
            },
          });
        }
      }

      res.redirect('/pool');
    } catch (err) {
      next(err);
    }
    });
    });
  });

  router.post('/:id/zurueck-in-pool', csrfProtection, async (req, res, next) => {
    try {
      const job = loadAuthorizedJob(req, res);
      if (!job) return;

      // The hint is best-effort, not a hard requirement — an unparseable, non-existent, or
      // deactivated Konto id is simply ignored (releases the job exactly as if no hint had been
      // given) rather than blocking the release or erroring out.
      const hinweisKonto = req.body.hinweisKontoId ? getKontoById(db, Number(req.body.hinweisKontoId)) : null;
      const gueltigerHinweis = hinweisKonto && hinweisKonto.aktiv ? hinweisKonto : null;

      // Use job.zugewiesen_an, not req.currentPerson.churchtools_person_id: releaseJob's guard
      // requires zugewiesen_an to match the person passed in, and for a Portal-Admin authorized
      // via the freigabe1_eskaliert_an_admin branch, the admin's own ID never equals
      // job.zugewiesen_an (still the excluded Stellvertreter1's ID) — passing the admin's ID would
      // silently match zero rows while still redirecting to /pool as if it had succeeded. For the
      // ordinary (non-admin) path this is definitionally identical, since loadAuthorizedJob already
      // verified job.zugewiesen_an === req.currentPerson.churchtools_person_id to get here.
      releaseJob(db, job.id, job.zugewiesen_an, { hinweisKontoId: gueltigerHinweis ? gueltigerHinweis.id : null });

      if (gueltigerHinweis) {
        const freigeber1 = getPersonById(db, gueltigerHinweis.freigeber1_id);
        if (freigeber1) {
          await sendNotification(db, mailer, {
            to: freigeber1.email,
            typ: 'zuweisung',
            jobId: job.id,
            variablen: {
              empfaengerName: `${freigeber1.vorname} ${freigeber1.nachname}`,
              jobDateiname: job.dateiname,
              grund: `Eine Rechnung wurde mit dem Hinweis in den Pool zurückgelegt, dass sie vermutlich für dein Konto ${gueltigerHinweis.kontonummer} — ${gueltigerHinweis.bezeichnung} bestimmt ist.`,
              link: `${config.publicBaseUrl}/pool`,
            },
          });
        }
      }

      res.redirect('/pool');
    } catch (err) {
      next(err);
    }
  });

  router.post('/:id/an-gruppe-zurueck', csrfProtection, (req, res) => {
    const job = loadAuthorizedJob(req, res);
    if (!job) return;

    const bemerkung = (req.body.bemerkung || '').trim();
    if (!bemerkung) {
      return res.status(400).render('error', { message: 'Bitte eine Bemerkung angeben.' });
    }

    sendJobBackToGroup(db, job.id, job.zugewiesen_an, { bemerkung });
    createFreigabe(db, {
      jobId: job.id,
      personId: req.currentPerson.churchtools_person_id,
      rolle: 'pool_ruecksendung',
      zeitpunkt: new Date().toISOString(),
      ip: req.ip,
      interessenskonflikt: false,
      kommentar: bemerkung,
      eskaliertVon: null,
    });
    res.redirect('/pool');
  });

  router.post('/:id/als-kk-abrechnung', csrfProtection, async (req, res, next) => {
    try {
      const job = loadAuthorizedJob(req, res);
      if (!job) return;
      if (getConfigValue(db, 'modul_kreditkarten_aktiv') !== '1') {
        return res.status(403).render('error', { message: 'Die Kreditkarten-Belege sind derzeit deaktiviert.' });
      }
      const karte = getKreditkarteById(db, Number(req.body.kreditkarteId));
      if (!karte || !karte.aktiv) return res.status(400).render('error', { message: 'Bitte eine gültige Karte wählen.' });
      const ok = await markiereAlsKkAbrechnung(db, config, mailer, { job, karte, markiertVon: req.currentPerson, ip: req.ip, ausStatus: 'zugewiesen' });
      if (!ok) return res.status(409).render('error', { message: 'Diese Rechnung wurde inzwischen bereits von einem anderen Vorgang bearbeitet.' });
      res.redirect(karte.verantwortlich_id === req.currentPerson.churchtools_person_id ? `/kontierung/${job.id}/kk-abgleich` : '/pool');
    } catch (err) {
      next(err);
    }
  });

  router.post('/:id/kk-markierung-aufheben', csrfProtection, (req, res) => {
    const job = loadAuthorizedJob(req, res);
    if (!job) return;
    if (!job.kreditkarte_id) return res.status(409).render('error', { message: 'Diese Abrechnung ist keiner Kreditkarte zugeordnet.' });
    const bemerkung = (req.body.bemerkung || '').trim();
    if (!bemerkung) return res.status(400).render('error', { message: 'Bitte eine Bemerkung angeben.' });
    db.exec('BEGIN');
    let ok = false;
    try {
      ok = hebeKkMarkierungAuf(db, job.id) && sendJobBackToGroup(db, job.id, job.zugewiesen_an, { bemerkung });
      if (ok) {
        createFreigabe(db, {
          jobId: job.id, personId: req.currentPerson.churchtools_person_id, rolle: 'kk_markierung_aufgehoben',
          zeitpunkt: new Date().toISOString(), ip: req.ip, interessenskonflikt: false, kommentar: bemerkung, eskaliertVon: null,
        });
      }
      db.exec(ok ? 'COMMIT' : 'ROLLBACK');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    if (!ok) return res.status(409).render('error', { message: 'Diese Abrechnung wurde inzwischen bereits von einem anderen Vorgang bearbeitet.' });
    res.redirect('/pool');
  });

  function renderAufsplittenForm(req, res, status, job, konten, alleKonten, gesamtbetrag, teile, begruendung, errors) {
    res.status(status).render('kontierung-aufsplitten', { job, konten, alleKonten, gesamtbetrag, teile, begruendung, errors });
  }

  router.get('/:id/aufsplitten', (req, res) => {
    const job = loadAuthorizedJob(req, res);
    if (!job) return;
    if (sperreKkAbrechnung(job, res)) return;
    const konten = ladeKontenFuerJob(req, job);
    // The Kontierung form's own Betrag field (already pre-filled from the original Rechnung —
    // QR-erkannt or previously saved) is passed in as ?betrag=... when the Aufsplitten-Popup is
    // opened, so a value the person typed there but hasn't saved yet still shows up here instead
    // of falling back to whatever is (or isn't) persisted on the job.
    const queryBetrag = typeof req.query.betrag === 'string' && BETRAG_PATTERN.test(req.query.betrag) ? req.query.betrag : null;
    renderAufsplittenForm(req, res, 200, job, konten, listKonten(db), queryBetrag || job.betrag || '', [
      { kontoId: '', betrag: '', interessenskonflikt: false },
      { kontoId: '', betrag: '', interessenskonflikt: false },
    ], '', []);
  });

  router.post('/:id/aufsplitten', (req, res, next) => {
    uploadBeleg.any()(req, res, async (uploadErr) => {
    // csrfProtection runs after multer parses the multipart body (the _csrf field included) —
    // any earlier and req.body would still be empty, rejecting every legitimate submission.
    csrfProtection(req, res, async (csrfErr) => {
    if (csrfErr) return next(csrfErr);
    try {
      const job = loadAuthorizedJob(req, res);
      if (!job) return;
      if (sperreKkAbrechnung(job, res)) return;
      const konten = ladeKontenFuerJob(req, job);
      const alleKonten = listKonten(db);

      const gesamtbetrag = req.body.gesamtbetrag || '';
      const kontoIds = [].concat(req.body.teilKontoId || []);
      const betraege = [].concat(req.body.teilBetrag || []);
      const konflikte = [].concat(req.body.teilInteressenskonflikt || []);
      const positionen = [].concat(req.body.teilPosition || []);
      const begruendung = req.body.begruendung || '';
      const teileEingabe = kontoIds.map((kontoId, i) => ({
        kontoId,
        betrag: betraege[i] || '',
        interessenskonflikt: konflikte[i] === 'true',
        position: (positionen[i] || '').trim() || null,
      }));

      const errors = [];
      if (uploadErr) {
        errors.push(uploadErr.code === 'LIMIT_FILE_SIZE' ? 'Ein Beleg darf höchstens 20 MB gross sein.' : 'Fehler beim Datei-Upload.');
      }
      if (!gesamtbetrag || !BETRAG_PATTERN.test(gesamtbetrag)) {
        errors.push('Bitte einen gültigen Gesamtbetrag erfassen (z.B. 200.00).');
      }
      if (teileEingabe.filter((t) => t.kontoId || t.betrag).length < 2) {
        errors.push('Mindestens zwei Teilbeträge sind nötig, um aufzusplitten.');
      }

      // The browser renames each row's file input to teilBeleg_<i> at submit time, matching that
      // row's current position — see kontierung-aufsplitten.ejs. Matched against aufgeloesteTeile
      // below via originalIndex, not array position, since blank rows are filtered out there.
      const teilBelegByIndex = new Map();
      for (const file of req.files || []) {
        const match = /^teilBeleg_(\d+)$/.exec(file.fieldname);
        if (!match) continue;
        const mimetype = detectBelegMimetype(file.buffer);
        if (!mimetype || mimetype !== file.mimetype) {
          errors.push('Beleg muss eine PDF-, PNG- oder JPEG-Datei sein.');
          continue;
        }
        teilBelegByIndex.set(Number(match[1]), { file, mimetype });
      }

      const aufgeloesteTeile = [];
      teileEingabe.forEach((teil, originalIndex) => {
        if (!teil.kontoId && !teil.betrag) return;
        const konto = alleKonten.find((k) => String(k.id) === teil.kontoId);
        if (!konto) {
          errors.push('Bitte für jede Zeile ein gültiges Konto auswählen.');
          return;
        }
        if (!teil.betrag || !BETRAG_PATTERN.test(teil.betrag)) {
          errors.push('Jede Zeile braucht einen gültigen Betrag (z.B. 123.45).');
          return;
        }
        if (teil.position && !POSITION_PATTERN.test(teil.position)) {
          errors.push('Position auf der Rechnung darf keine Sonderzeichen enthalten (z.B. Emoji), die nicht gestempelt werden können.');
          return;
        }
        const belegEintrag = teilBelegByIndex.get(originalIndex);
        aufgeloesteTeile.push({
          konto, betrag: teil.betrag.replace(',', '.'), interessenskonflikt: teil.interessenskonflikt, position: teil.position, originalIndex,
          beleg: belegEintrag ? { buffer: belegEintrag.file.buffer, mimetype: belegEintrag.mimetype } : null,
        });
      });

      if (errors.length === 0) {
        const summe = aufgeloesteTeile.reduce((sum, t) => sum + Number(t.betrag), 0);
        const original = Number(gesamtbetrag.replace(',', '.'));
        if (Math.abs(summe - original) > 0.005) {
          errors.push(`Die Summe der Teilbeträge (${summe.toFixed(2)}) muss dem Gesamtbetrag (${original.toFixed(2)}) entsprechen.`);
        }
      }

      // Nur Zeilen auf eigenen Konten (in `konten`, inkl. des Admin-Eskalations-Fallbacks aus
      // ladeKontenFuerJob) können überhaupt einen Interessenskonflikt haben — für ein fremdes
      // Konto ist die Checkbox bedeutungslos, siehe Design-Spec.
      const hatKonflikt = aufgeloesteTeile.some((t) => t.interessenskonflikt && konten.some((k) => k.id === t.konto.id));
      if (hatKonflikt && !begruendung) {
        errors.push('Bei einem Interessenskonflikt ist eine Begründung Pflicht.');
      }

      if (errors.length > 0) {
        return renderAufsplittenForm(req, res, 400, job, konten, alleKonten, gesamtbetrag, teileEingabe, begruendung, errors);
      }

      // Persisted on the parent even though it's about to be retired: the parent may never have
      // had a Betrag saved before (that's exactly the gap this Gesamtbetrag field closes), and
      // its own record should reflect the real total the split was based on, not stay empty.
      job.betrag = gesamtbetrag.replace(',', '.');

      // File I/O (including the async Beleg merge) happens before the DB transaction below —
      // see bereiteTeilDateienVor in services/aufsplitten.js.
      const vorbereiteteTeile = await bereiteTeilDateienVor(config, job, aufgeloesteTeile);

      let ergebnis;
      db.exec('BEGIN');
      try {
        setJobBetrag(db, job.id, job.betrag);
        const markiert = markJobAufgesplittet(db, job.id);
        if (!markiert) {
          db.exec('ROLLBACK');
          return res.status(409).render('error', { message: 'Diese Rechnung wurde inzwischen bereits von einem anderen Vorgang bearbeitet.' });
        }
        ergebnis = erzeugeTeilJobs(db, {
          job,
          teile: vorbereiteteTeile,
          konten,
          person: req.currentPerson,
          ip: req.ip,
          begruendung,
          fremdKontoModus: 'pool',
          istVertretung: !job.freigabe1_eskaliert_an_admin && istAktiveVertretungFuer(db, req.currentPerson.churchtools_person_id, job.zugewiesen_an),
        });
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }

      await benachrichtigeNachAufsplitten(db, mailer, config, { job, ergebnis, person: req.currentPerson });
      await pruefeIbanNachAufsplitten(db, mailer, config, { job, teile: aufgeloesteTeile, konten, person: req.currentPerson, ip: req.ip });

      res.redirect('/pool');
    } catch (err) {
      next(err);
    }
    });
    });
  });

  return router;
}
