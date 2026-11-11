// Spesen einreichen (`/spesen/neu`, `POST /spesen`, docs/spesen-einreichung.md): eine Person reicht eine Abrechnung mit mehreren Positionen (Konto, Betrag, Datum, Zweck, Beleg) ein. Jede Position
// wird ein eigener Vorgang (quelle 'spesen') beim Freigeber 1 des Kontos. Reicht die Person selbst als Freigeber 1 ein, geht die Position als Interessenskonflikt an die Stellvertretung. Zugang: angemeldet;
// bei deaktiviertem Spesenmodul 403.

import { Router } from 'express';
import multer from 'multer';
import { mitAuditKontext } from '../services/auditContext.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { listKonten, filterKontenFuerTyp, kontoErlaubtFuerTyp } from '../db/kontenRepo.js';
import { getConfigValue } from '../db/adminConfigRepo.js';
import { createSpesenabrechnung } from '../db/spesenabrechnungenRepo.js';
import { createSpesenPosition, getJobById } from '../db/jobsRepo.js';
import { createFreigabe } from '../db/freigabenRepo.js';
import { getPersonById } from '../db/personenRepo.js';
import { detectBelegMimetype, buildBelegPdf } from '../services/belegAnhaengen.js';
import { pruefeEingangsPdf, PdfEingangFehler } from '../services/pdfEingang.js';
import { renderFirstPageThumbnail } from '../services/thumbnail.js';
import { sendNotification } from '../services/notify.js';
import { asyncCallback } from '../middleware/asyncHandler.js';

const BETRAG_PATTERN = /^\d+([.,]\d{1,2})?$/;
const AUSLAGE_DATUM_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_BELEG_SIZE = 20 * 1024 * 1024;
const MAX_POSITIONEN = 25;

const uploadBelege = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BELEG_SIZE, files: MAX_POSITIONEN } });

// Ein Spesenbeleg-Upload wird von buildBelegPdf immer zu einem echten PDF, egal ob er als PDF/PNG/JPEG ankam — der gespeicherte Download-Dateiname muss also immer ebenfalls eine .pdf-Endung tragen,
// sonst behält ein Bild-Upload seinen ursprünglichen Namen .jpg/.png, obwohl die ausgelieferten Bytes jetzt ein PDF sind.
function mitPdfEndung(originalname) {
  return `${originalname.replace(/\.[^./]+$/, '')}.pdf`;
}

export function createSpesenRouter({ db, config, mailer, csrfProtection = (req, res, next) => next() }) {
  const router = Router();

  router.use((req, res, next) => {
    if (getConfigValue(db, 'modul_spesen_aktiv') === '0') {
      return res.status(403).render('error', { message: 'Die Spesen-Einreichung ist derzeit deaktiviert.' });
    }
    next();
  });

  // GET /spesen/neu – das Formular (zwei leere Positionen).
  router.get('/neu', (req, res) => {
    res.render('spesen-neu', {
      alleKonten: filterKontenFuerTyp(listKonten(db), 'rechnung'),
      values: { titel: '', positionen: [{}, {}] },
      errors: [],
    });
  });

  // POST /spesen – prüft alle Positionen (Konto, Betrag, Datum nicht in der Zukunft, Zweck, Beleg PDF/PNG/JPEG), legt Abrechnung und Positionen in einer Transaktion an und benachrichtigt die Zuständigen.
  router.post('/', (req, res, next) => {
    // multer muss vor csrfProtection laufen: Die CSRF-Prüfung liest req.body._csrf, das erst existiert, wenn multer den multipart-Body geparst hat — gleiche Reihenfolge wie bei den eigenen multipart-POST-Routen in kontierung.js.
    mitAuditKontext(uploadBelege.any())(req, res, (uploadErr) => {
      csrfProtection(req, res, asyncCallback(next, async (csrfErr) => {
        if (csrfErr) return next(csrfErr);
        try {
          const aktiveKonten = listKonten(db);
          const alleKonten = filterKontenFuerTyp(aktiveKonten, 'rechnung');
          const titel = (req.body.titel || '').trim() || null;
          const kontoIds = [].concat(req.body.posKontoId || []);
          const betraege = [].concat(req.body.posBetrag || []);
          const auslageDaten = [].concat(req.body.posAuslageDatum || []);
          const beschreibungen = [].concat(req.body.posBeschreibung || []);

          // Das Beleg-Eingabefeld jeder Zeile wird von der Seite selbst unmittelbar vor dem Absenden in einen positionsbezogenen Feldnamen (posBeleg_<i>) umbenannt — derselbe Kniff, den kontierung-aufsplitten.ejs für seine eigene optionale Datei je Zeile nutzt;
          // hier nötig, weil ein einfacher gemeinsamer Feldname sich still verschöbe, sobald das <input type="file"> irgendeiner Zeile gar nichts absendet.
          const belegByIndex = new Map();
          for (const file of req.files || []) {
            const match = /^posBeleg_(\d+)$/.exec(file.fieldname);
            if (match) belegByIndex.set(Number(match[1]), file);
          }

          const positionen = kontoIds.map((kontoId, i) => ({
            kontoId,
            betrag: betraege[i] || '',
            auslageDatum: auslageDaten[i] || '',
            beschreibung: (beschreibungen[i] || '').trim(),
            beleg: belegByIndex.get(i) || null,
          }));

          // Ein multer-Fehler (zu grosser Beleg, zu viele Dateien) darf nicht die ganze Einreichung mit einer allgemeinen 500 verwerfen — er wird in dieselbe 400-Neudarstellung gefaltet wie jeder andere Validierungsfehler unten, entsprechend der identischen uploadErr-Behandlung in kontierung.js.
          if (uploadErr) {
            return res.status(400).render('spesen-neu', {
              alleKonten,
              values: { titel: req.body.titel || '', positionen },
              errors: [uploadErr.code === 'LIMIT_FILE_SIZE' ? 'Ein Beleg darf höchstens 20 MB gross sein.' : 'Fehler beim Datei-Upload.'],
            });
          }

          const errors = [];
          const heute = new Date().toISOString().slice(0, 10);
          const aufgeloestePositionen = [];

          if (positionen.length === 0) {
            errors.push('Mindestens eine Position ist erforderlich.');
          }

          positionen.forEach((pos, i) => {
            const konto = aktiveKonten.find((k) => String(k.id) === pos.kontoId);
            if (!konto) {
              errors.push(`Position ${i + 1}: Bitte ein gültiges Konto wählen.`);
              return;
            }
            if (!kontoErlaubtFuerTyp(konto, 'rechnung')) {
              errors.push(`Position ${i + 1}: Dieses Konto kann nicht für Rechnungen verwendet werden.`);
              return;
            }
            if (!BETRAG_PATTERN.test(pos.betrag)) {
              errors.push(`Position ${i + 1}: Bitte einen gültigen Betrag angeben.`);
              return;
            }
            if (!AUSLAGE_DATUM_PATTERN.test(pos.auslageDatum) || pos.auslageDatum > heute) {
              errors.push(`Position ${i + 1}: Bitte ein gültiges, nicht in der Zukunft liegendes Auslage-Datum angeben.`);
              return;
            }
            if (!pos.beschreibung) {
              errors.push(`Position ${i + 1}: Bitte einen Verwendungszweck angeben.`);
              return;
            }
            if (!pos.beleg) {
              errors.push(`Position ${i + 1}: Bitte einen Beleg hochladen.`);
              return;
            }
            const mimetype = detectBelegMimetype(pos.beleg.buffer);
            if (!mimetype || mimetype !== pos.beleg.mimetype) {
              errors.push(`Position ${i + 1}: Beleg muss eine PDF-, PNG- oder JPEG-Datei sein.`);
              return;
            }
            aufgeloestePositionen.push({ ...pos, konto, betrag: pos.betrag.replace(',', '.'), mimetype, nummer: i + 1 });
          });

          // Ein PDF-Beleg wird unverändert zum Jobdokument (buildBelegPdf) -- er muss also genauso
          // verarbeitbar sein wie ein eingehendes Rechnungs-PDF (services/pdfEingang.js).
          for (const pos of aufgeloestePositionen) {
            if (pos.mimetype !== 'application/pdf') continue;
            try {
              await pruefeEingangsPdf(pos.beleg.buffer);
            } catch (err) {
              if (!(err instanceof PdfEingangFehler)) throw err;
              errors.push(`Position ${pos.nummer}: ${err.message}`);
            }
          }

          if (errors.length > 0) {
            return res.status(400).render('spesen-neu', { alleKonten, values: { titel: req.body.titel || '', positionen }, errors });
          }

          // Datei-I/O passiert vor der Datenbanktransaktion (wie im Aufsplitten-Handler von kontierung.js): synchrone Transaktionen im Stil von better-sqlite3 können ein await nicht offen halten.
          mkdirSync(config.jobsDir, { recursive: true });
          const vorbereitetePositionen = [];
          for (const pos of aufgeloestePositionen) {
            const pdfBuffer = await buildBelegPdf(pos.beleg.buffer, pos.mimetype);
            const pdfPfad = join(config.jobsDir, `job-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);
            writeFileSync(pdfPfad, pdfBuffer);
            let thumbnailPfad = null;
            try {
              const thumbnailPng = renderFirstPageThumbnail(pdfBuffer);
              thumbnailPfad = pdfPfad.replace(/\.pdf$/, '.png');
              writeFileSync(thumbnailPfad, thumbnailPng);
            } catch (err) {
              console.error(`Thumbnail-Rendering fehlgeschlagen für Spesen-Position (${pos.beleg.originalname}):`, err.message);
              thumbnailPfad = null;
            }
            vorbereitetePositionen.push({ ...pos, pdfPfad, thumbnailPfad });
          }

          const eingangAm = new Date().toISOString();
          const eingereichtVon = req.currentPerson.churchtools_person_id;
          const erstellteJobIds = [];
          const eskaliert = [];

          db.exec('BEGIN');
          try {
            const spesenabrechnungId = createSpesenabrechnung(db, { eingereichtVon, eingereichtAm: eingangAm, titel });
            for (const pos of vorbereitetePositionen) {
              const istSelbstFreigeber1 = pos.konto.freigeber1_id === eingereichtVon;
              const zugewiesenAn = istSelbstFreigeber1 ? pos.konto.stellvertreter1_id : pos.konto.freigeber1_id;
              const jobId = createSpesenPosition(db, {
                eingangAm,
                eingereichtVon,
                kontoId: pos.konto.id,
                betrag: pos.betrag,
                auslageDatum: pos.auslageDatum,
                beschreibung: pos.beschreibung,
                dateiname: mitPdfEndung(pos.beleg.originalname),
                pdfPfad: pos.pdfPfad,
                thumbnailPfad: pos.thumbnailPfad,
                spesenabrechnungId,
                zugewiesenAn,
                freigabe1EskaliertVon: istSelbstFreigeber1 ? eingereichtVon : null,
                freigabe1Eskalationsgrund: istSelbstFreigeber1 ? 'Selbsteinreichung durch Freigeber1' : null,
              });
              erstellteJobIds.push(jobId);
              if (istSelbstFreigeber1) {
                createFreigabe(db, {
                  jobId,
                  personId: eingereichtVon,
                  rolle: 'freigabe1_eskalation',
                  zeitpunkt: eingangAm,
                  ip: req.ip,
                  interessenskonflikt: true,
                  kommentar: 'Selbsteinreichung durch Freigeber1',
                  eskaliertVon: null,
                });
                eskaliert.push({ jobId, konto: pos.konto });
              }
            }
            db.exec('COMMIT');
          } catch (err) {
            db.exec('ROLLBACK');
            throw err;
          }

          for (const jobId of erstellteJobIds) {
            const job = getJobById(db, jobId);
            const zustaendig = getPersonById(db, job.zugewiesen_an);
            if (!zustaendig) continue;
            const istEskaliert = eskaliert.some((e) => e.jobId === jobId);
            await sendNotification(db, mailer, {
              to: zustaendig.email,
              typ: 'zuweisung',
              jobId: job.id,
              variablen: {
                empfaengerName: `${zustaendig.vorname} ${zustaendig.nachname}`,
                jobDateiname: job.dateiname,
                grund: istEskaliert
                  ? `Eine Spesen-Position wartet auf deine Prüfung (Freigabe 1). Grund für die Zuweisung an dich: ${job.freigabe1_eskalationsgrund}`
                  : 'Eine Spesen-Position wartet auf deine Prüfung (Freigabe 1).',
                link: `${config.publicBaseUrl}/spesen-freigabe1/${job.id}`,
              },
            });
          }

          res.redirect('/pool');
        } catch (err) {
          next(err);
        }
      }));
    });
  });

  return router;
}
