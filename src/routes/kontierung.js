import { Router } from 'express';
import multer from 'multer';
import { mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mergeBelegInPdf, detectBelegMimetype, countBelegSeiten } from '../services/belegAnhaengen.js';
import {
  getJobById,
  setKontierung,
  updateKontierungMetadaten,
  ablehnenJob,
  eskalierenFreigabe1,
  eskalierenFreigabe1AnAdmin,
  abschliessenFreigabe1,
  releaseJob,
  getEffectiveFreigeber2Id,
  markJobAufgesplittet,
  createSplitJob,
  setJobBetrag,
  addBelegSeiten,
} from '../db/jobsRepo.js';
import { listKontenForPerson, getKontoById, listKonten } from '../db/kontenRepo.js';
import { listDebitoren, getDebitorById, createDebitor } from '../db/debitorenRepo.js';
import { findDebitorIbanByIban, listDebitorIbansByDebitor, createDebitorIban } from '../db/debitorIbanRepo.js';
import { createFreigabe } from '../db/freigabenRepo.js';
import { buildSignedDownloadUrl, PDF_PREVIEW_TTL_SECONDS } from '../services/downloadUrl.js';
import { getPersonById } from '../db/personenRepo.js';
import { sendNotification, resolveEmpfaenger } from '../services/notify.js';
import { buildAuditLog } from '../services/auditLog.js';
import { getConfigValue } from '../db/adminConfigRepo.js';
import { isValidIban } from '../services/ibanUtils.js';

const BETRAG_PATTERN = /^\d+([.,]\d{1,2})?$/;
const ZAHLUNGSZIEL_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
// teilPosition landet später wörtlich auf der gemeinsamen Stempelseite der Splitgruppe
// (stampGruppenDokument, pdfStamp.js), die mit pdf-lib's Helvetica-Standardfont gezeichnet wird —
// und der kann ausschliesslich WinAnsi (Windows-1252) darstellen. Ein Emoji o.ä. würde das
// Stempeln erst beim asynchronen Gruppen-Merge zum Scheitern bringen, wo niemand mehr eine
// Rückmeldung bekommt und der Nachhol-Cron-Job denselben Fehler endlos wiederholt. Deshalb wird
// dieses eine Feld schon beim Absenden geprüft, wo die Person die Zeile direkt korrigieren kann.
//
// Bewusst eine explizite Positivliste statt \p{L}/\p{N}: Unicode-Buchstaben/-Ziffern umfassen auch
// Kyrillisch, CJK, Latin-Extended-A (Ř, Ł, ...) und eingekreiste Ziffern, die Helvetica allesamt
// NICHT kodieren kann — und \s liesse Tab/Zeilenumbruch durch, die ebenfalls werfen. Umgekehrt
// waren WinAnsi-sichere Alltagszeichen wie & % + ' vorher fälschlich verboten.
// \u0020-\u007E ist druckbares ASCII (schliesst rohe Tabs/Zeilenumbrüche bewusst aus),
// \u00A0-\u00FF ist Latin-1 Supplement (deutsche Umlaute, französische/skandinavische Akzente
// usw.); der Rest sind die Windows-1252-Extras ausserhalb von Latin-1, die hier realistisch
// vorkommen: Œ œ Š š Ž ž Ÿ sowie Halbgeviert-/Geviertstrich (die im Rest dieses Codes ohnehin
// schon in PDF-Texten verwendet werden).
const POSITION_PATTERN = /^[\u0020-\u007E\u00A0-\u00FFŒœŠšŽžŸ–—]*$/;
const MAX_BELEG_SIZE = 20 * 1024 * 1024;
// Aufsplitten sends one optional beleg file per Teil row (teilBeleg_<i>) via uploadBeleg.any(),
// which has no field-name allowlist — without a files cap, a request forging many parts could
// force up to fileSize each into memory. No real form has anywhere near this many Teile.
const MAX_BELEG_FILES = 25;

const uploadBeleg = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BELEG_SIZE, files: MAX_BELEG_FILES },
});

function neuerDateipfad(jobsDir, quelldatei) {
  mkdirSync(jobsDir, { recursive: true });
  const endung = quelldatei.slice(quelldatei.lastIndexOf('.'));
  const zielPfad = join(jobsDir, `job-${Date.now()}-${Math.random().toString(36).slice(2)}${endung}`);
  copyFileSync(quelldatei, zielPfad);
  return zielPfad;
}

// Merges an uploaded Beleg (multer file) into the PDF at pdfPfad, in place — used once the
// caller has already confirmed the surrounding Kontierung/Aufsplitten action actually persisted,
// so a file that turns out not to apply (e.g. a 409 race) never mutates the PDF on disk.
async function mergeBelegFuerJob(pdfPfad, file, mimetype) {
  const merged = await mergeBelegInPdf(readFileSync(pdfPfad), file.buffer, mimetype);
  writeFileSync(pdfPfad, merged);
}

function pruefeIbanAbgleich(db, debitorId, qrIban) {
  const hinterlegte = listDebitorIbansByDebitor(db, debitorId);
  if (hinterlegte.length === 0) return { status: 'kein_abgleich' };
  return { status: hinterlegte.some((row) => row.iban === qrIban) ? 'match' : 'mismatch' };
}

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

  function isSuperadmin(person) {
    return Boolean(person && person.gruppen.includes(String(config.churchtools.groupIdAdmin)));
  }

  function loadAuthorizedJob(req, res) {
    const job = getJobById(db, Number(req.params.id));
    if (!job || job.status !== 'zugewiesen') {
      res.status(403).render('error', { message: 'Dieser Job ist dir aktuell nicht zur Kontierung zugewiesen.' });
      return null;
    }
    const authorized = job.freigabe1_eskaliert_an_admin
      ? isSuperadmin(req.currentPerson)
      : job.zugewiesen_an === req.currentPerson.churchtools_person_id;
    if (!authorized) {
      res.status(403).render('error', { message: 'Dieser Job ist dir aktuell nicht zur Kontierung zugewiesen.' });
      return null;
    }
    return job;
  }

  // The form's existing pre-fill (values.kontoId defaults to job.konto_id) already assumes the
  // job's currently-assigned Konto is the expected resubmission target. listKontenForPerson
  // alone is role-filtered, though, and a Portal-Admin resolving a self-escalated job (case B in
  // the POST handler below) holds no freigeber1/stellvertreter1 role on that Konto BY
  // DEFINITION — that's exactly what made it a self-escalation. Without this, such an admin
  // could view the form (200) but never submit it: the dropdown has nothing selectable and
  // konten.find(...) in the POST handler always fails. Unconditional, not gated on
  // freigabe1_eskaliert_an_admin, since it's a no-op for the normal case: the job's Konto is
  // already in a legitimately-role-holding person's own listKontenForPerson result.
  function ladeKontenFuerJob(req, job) {
    const konten = listKontenForPerson(db, req.currentPerson.churchtools_person_id);
    if (job.konto_id && !konten.some((k) => k.id === job.konto_id)) {
      const bestehendes = getKontoById(db, job.konto_id);
      if (bestehendes) konten.push(bestehendes);
    }
    return konten;
  }

  router.get('/:id', (req, res) => {
    const job = loadAuthorizedJob(req, res);
    if (!job) return;
    const konten = ladeKontenFuerJob(req, job);
    const qrInfo = buildQrInfo(db, job);
    res.render('kontierung', {
      job,
      konten,
      alleKonten: listKonten(db),
      debitoren: listDebitoren(db),
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
              subject: 'Freigabeportal: Rechnung abgelehnt (an Portal-Admin eskaliert)',
              text: `Eine an die Portal-Admin-Gruppe eskalierte Rechnung wurde abgelehnt: ${job.dateiname}\n\nGrund: ${begruendung}\n\nBitte im Freigabeportal anmelden, um sie zu überarbeiten: ${config.publicBaseUrl}/abgelehnt/${job.id}`,
              typ: 'ablehnung',
              jobId: job.id,
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
              subject: 'Freigabeportal: IBAN-Abweichung bei Rechnung festgestellt',
              text: `Bei der Kontierung von "${job.dateiname}" (Lieferant: ${debitor.name}) weicht die im QR-Code gefundene IBAN (${job.qr_iban}) von der hinterlegten IBAN ab. Bitte prüfen: ${config.publicBaseUrl}/kontierung/${job.id}`,
              typ: 'iban-warnung',
              jobId: job.id,
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

      if (eskaliertAnAdmin) {
        const empfaenger = resolveEmpfaenger(db, config, 'gruppe:admin');
        for (const email of empfaenger) {
          await sendNotification(db, mailer, {
            to: email,
            subject: 'Freigabeportal: Interessenskonflikt bei Freigabe 1 – an Portal-Admin eskaliert',
            text: `Eine Rechnung wurde an die Portal-Admin-Gruppe eskaliert, da auch die Stellvertretung einen Interessenskonflikt erklärt hat: ${job.dateiname}\n\nBitte im Freigabeportal anmelden: ${config.publicBaseUrl}/kontierung/${job.id}`,
            typ: 'zuweisung',
            jobId: job.id,
          });
        }
      } else if (hatKonflikt) {
        const stellvertreter1 = getPersonById(db, konto.stellvertreter1_id);
        if (stellvertreter1) {
          await sendNotification(db, mailer, {
            to: stellvertreter1.email,
            subject: 'Freigabeportal: Interessenskonflikt bei Freigabe 1 – Kontierung an dich übergeben',
            text: `Eine Rechnung wurde dir zur Kontierung übergeben, da ${req.currentPerson.vorname} ${req.currentPerson.nachname} einen Interessenskonflikt erklärt hat: ${job.dateiname}\n\nBitte im Freigabeportal anmelden: ${config.publicBaseUrl}/kontierung/${job.id}`,
            typ: 'zuweisung',
            jobId: job.id,
          });
        }
      } else {
        const freigeber2 = getPersonById(db, getEffectiveFreigeber2Id(job, konto));
        if (freigeber2) {
          await sendNotification(db, mailer, {
            to: freigeber2.email,
            subject: 'Freigabeportal: Neue Rechnung zur Freigabe 2',
            text: `Eine Rechnung wartet auf deine Freigabe 2: ${job.dateiname}\n\nBitte im Freigabeportal anmelden: ${config.publicBaseUrl}/freigabe2/${job.id}`,
            typ: 'zuweisung',
            jobId: job.id,
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
            subject: 'Freigabeportal: Rechnung vermutlich für dein Konto — bitte aus dem Pool holen',
            text: `Eine Rechnung wurde mit dem Hinweis in den Pool zurückgelegt, dass sie vermutlich für dein Konto ${gueltigerHinweis.kontonummer} — ${gueltigerHinweis.bezeichnung} bestimmt ist: ${job.dateiname}\n\nBitte im Freigabeportal anmelden und aus dem Pool holen: ${config.publicBaseUrl}/pool`,
            typ: 'zuweisung',
            jobId: job.id,
          });
        }
      }

      res.redirect('/pool');
    } catch (err) {
      next(err);
    }
  });

  function renderAufsplittenForm(req, res, status, job, konten, alleKonten, gesamtbetrag, teile, begruendung, errors) {
    res.status(status).render('kontierung-aufsplitten', { job, konten, alleKonten, gesamtbetrag, teile, begruendung, errors });
  }

  router.get('/:id/aufsplitten', (req, res) => {
    const job = loadAuthorizedJob(req, res);
    if (!job) return;
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
        aufgeloesteTeile.push({ konto, betrag: teil.betrag.replace(',', '.'), interessenskonflikt: teil.interessenskonflikt, position: teil.position, originalIndex });
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

      // File I/O (including the async Beleg merge) happens before the DB transaction below,
      // mirroring the "PDF work before BEGIN" pattern in freigabe2.js — better-sqlite3 has no
      // real async transactions, so an await inside BEGIN/COMMIT would hold it open across the
      // event loop. On the rare 409 (markJobAufgesplittet already run by another request), these
      // freshly-copied files are simply orphaned — the same class of leftover-file risk the
      // per-Zeile loop below already accepts if a later Zeile throws mid-transaction.
      const vorbereiteteTeile = [];
      for (const teil of aufgeloesteTeile) {
        const pdfPfad = neuerDateipfad(config.jobsDir, job.pdf_pfad);
        const thumbnailPfad = job.thumbnail_pfad ? neuerDateipfad(config.jobsDir, job.thumbnail_pfad) : null;
        const beleg = teilBelegByIndex.get(teil.originalIndex);
        // Die Seitenzahl des Belegs wird hier — und nur hier — festgehalten: mergeBelegFuerJob
        // hängt die Belegseiten direkt hinter die Rechnungsseiten, aber die spätere
        // Einzel-Freigabe-2 dieses Kindes hängt noch eigene Stempelseiten dahinter. Ohne diesen
        // Wert könnte der Gruppen-Merge die Belegseiten nachher nicht mehr von den Stempelseiten
        // unterscheiden (siehe haengeBelegSeitenAn in splitGruppenExport.js).
        let belegSeitenzahl = null;
        if (beleg) {
          belegSeitenzahl = await countBelegSeiten(beleg.file.buffer, beleg.mimetype);
          await mergeBelegFuerJob(pdfPfad, beleg.file, beleg.mimetype);
        }
        vorbereiteteTeile.push({ ...teil, pdfPfad, thumbnailPfad, belegSeitenzahl });
      }

      db.exec('BEGIN');
      const selbstFreigegeben = [];
      const eskaliert = [];
      const eskaliertAnAdmin = [];
      const fremdeKonten = [];
      try {
        setJobBetrag(db, job.id, job.betrag);
        const markiert = markJobAufgesplittet(db, job.id);
        if (!markiert) {
          db.exec('ROLLBACK');
          return res.status(409).render('error', { message: 'Diese Rechnung wurde inzwischen bereits von einem anderen Vorgang bearbeitet.' });
        }
        for (const teil of vorbereiteteTeile) {
          const { pdfPfad, thumbnailPfad } = teil;
          const istEigenesKonto = konten.some((k) => k.id === teil.konto.id);

          if (!istEigenesKonto) {
            const kindId = createSplitJob(db, job, {
              pdfPfad,
              thumbnailPfad,
              hinweisKontoId: teil.konto.id,
              betrag: teil.betrag,
              position: teil.position,
              belegSeitenzahl: teil.belegSeitenzahl,
            });
            fremdeKonten.push({ id: kindId, konto: teil.konto });
            continue;
          }

          const kindId = createSplitJob(db, job, {
            pdfPfad,
            thumbnailPfad,
            kontoId: teil.konto.id,
            betrag: teil.betrag,
            zugewiesenAn: req.currentPerson.churchtools_person_id,
            position: teil.position,
            belegSeitenzahl: teil.belegSeitenzahl,
          });

          if (teil.interessenskonflikt) {
            const zeileEskaliertAnAdmin = Boolean(job.freigabe1_eskaliert_von || teil.konto.stellvertreter1_id === req.currentPerson.churchtools_person_id);
            createFreigabe(db, {
              jobId: kindId,
              personId: req.currentPerson.churchtools_person_id,
              rolle: 'freigabe1_eskalation',
              zeitpunkt: new Date().toISOString(),
              ip: req.ip,
              interessenskonflikt: true,
              kommentar: begruendung,
              eskaliertVon: job.freigabe1_eskaliert_von,
            });
            if (zeileEskaliertAnAdmin) {
              eskalierenFreigabe1AnAdmin(db, kindId, { eskaliertVon: req.currentPerson.churchtools_person_id, grund: begruendung });
              eskaliertAnAdmin.push({ id: kindId, konto: teil.konto });
            } else {
              eskalierenFreigabe1(db, kindId, {
                eskaliertVon: req.currentPerson.churchtools_person_id,
                grund: begruendung,
                stellvertreterId: teil.konto.stellvertreter1_id,
              });
              eskaliert.push({ id: kindId, konto: teil.konto });
            }
          } else {
            createFreigabe(db, {
              jobId: kindId,
              personId: req.currentPerson.churchtools_person_id,
              rolle: 'freigeber1',
              zeitpunkt: new Date().toISOString(),
              ip: req.ip,
              interessenskonflikt: false,
              kommentar: null,
              eskaliertVon: null,
            });
            abschliessenFreigabe1(db, kindId);
            selbstFreigegeben.push({ id: kindId, konto: teil.konto });
          }
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }

      for (const { id: kindId, konto } of selbstFreigegeben) {
        const kindJob = getJobById(db, kindId);
        const freigeber2 = getPersonById(db, getEffectiveFreigeber2Id(kindJob, konto));
        if (freigeber2) {
          await sendNotification(db, mailer, {
            to: freigeber2.email,
            subject: 'Freigabeportal: Neue Rechnung zur Freigabe 2',
            text: `Eine Rechnung wartet auf deine Freigabe 2: ${kindJob.dateiname}\n\nBitte im Freigabeportal anmelden: ${config.publicBaseUrl}/freigabe2/${kindJob.id}`,
            typ: 'zuweisung',
            jobId: kindJob.id,
          });
        }
      }

      for (const { id: kindId, konto } of eskaliert) {
        const stellvertreter1 = getPersonById(db, konto.stellvertreter1_id);
        if (stellvertreter1) {
          await sendNotification(db, mailer, {
            to: stellvertreter1.email,
            subject: 'Freigabeportal: Interessenskonflikt bei Freigabe 1 – Kontierung an dich übergeben',
            text: `Eine Rechnung wurde dir zur Kontierung übergeben, da ${req.currentPerson.vorname} ${req.currentPerson.nachname} einen Interessenskonflikt erklärt hat: ${job.dateiname}\n\nBitte im Freigabeportal anmelden: ${config.publicBaseUrl}/kontierung/${kindId}`,
            typ: 'zuweisung',
            jobId: kindId,
          });
        }
      }

      for (const { id: kindId } of eskaliertAnAdmin) {
        const empfaenger = resolveEmpfaenger(db, config, 'gruppe:admin');
        for (const email of empfaenger) {
          await sendNotification(db, mailer, {
            to: email,
            subject: 'Freigabeportal: Interessenskonflikt bei Freigabe 1 – an Portal-Admin eskaliert',
            text: `Eine Rechnung wurde an die Portal-Admin-Gruppe eskaliert, da auch die Stellvertretung einen Interessenskonflikt erklärt hat: ${job.dateiname}\n\nBitte im Freigabeportal anmelden: ${config.publicBaseUrl}/kontierung/${kindId}`,
            typ: 'zuweisung',
            jobId: kindId,
          });
        }
      }

      for (const { id: kindId, konto } of fremdeKonten) {
        const freigeber1 = getPersonById(db, konto.freigeber1_id);
        if (freigeber1) {
          await sendNotification(db, mailer, {
            to: freigeber1.email,
            subject: 'Freigabeportal: Rechnung vermutlich für dein Konto — bitte aus dem Pool holen',
            text: `Eine Rechnung wurde mit dem Hinweis in den Pool zurückgelegt, dass sie vermutlich für dein Konto ${konto.kontonummer} — ${konto.bezeichnung} bestimmt ist: ${job.dateiname}\n\nBitte im Freigabeportal anmelden und aus dem Pool holen: ${config.publicBaseUrl}/pool`,
            typ: 'zuweisung',
            jobId: kindId,
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

  return router;
}
