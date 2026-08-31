import { Router } from 'express';
import multer from 'multer';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { listKonten } from '../db/kontenRepo.js';
import { createSpesenabrechnung } from '../db/spesenabrechnungenRepo.js';
import { createSpesenPosition, getJobById } from '../db/jobsRepo.js';
import { createFreigabe } from '../db/freigabenRepo.js';
import { getPersonById } from '../db/personenRepo.js';
import { detectBelegMimetype, buildBelegPdf } from '../services/belegAnhaengen.js';
import { renderFirstPageThumbnail } from '../services/thumbnail.js';
import { sendNotification } from '../services/notify.js';

const BETRAG_PATTERN = /^\d+([.,]\d{1,2})?$/;
const AUSLAGE_DATUM_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_BELEG_SIZE = 20 * 1024 * 1024;
const MAX_POSITIONEN = 25;

const uploadBelege = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BELEG_SIZE, files: MAX_POSITIONEN } });

export function createSpesenRouter({ db, config, mailer, csrfProtection = (req, res, next) => next() }) {
  const router = Router();

  router.get('/neu', (req, res) => {
    res.render('spesen-neu', {
      alleKonten: listKonten(db),
      values: { titel: '', positionen: [{}, {}] },
      errors: [],
    });
  });

  router.post('/', (req, res, next) => {
    // multer must run before csrfProtection: CSRF validation reads req.body._csrf, which only
    // exists once multer has parsed the multipart body — same ordering kontierung.js already
    // uses for its own multipart POST routes.
    uploadBelege.any()(req, res, (uploadErr) => {
      csrfProtection(req, res, async (csrfErr) => {
        if (csrfErr) return next(csrfErr);
        try {
          const alleKonten = listKonten(db);
          const titel = (req.body.titel || '').trim() || null;
          const kontoIds = [].concat(req.body.posKontoId || []);
          const betraege = [].concat(req.body.posBetrag || []);
          const auslageDaten = [].concat(req.body.posAuslageDatum || []);
          const beschreibungen = [].concat(req.body.posBeschreibung || []);

          // Each row's Beleg input is renamed to a positional fieldname (posBeleg_<i>) by the
          // page's own JS right before submit — same trick kontierung-aufsplitten.ejs already
          // uses for its own per-row optional file, needed here because a plain shared fieldname
          // would silently misalign once any row's <input type="file"> submits nothing at all.
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

          // A multer error (oversized Beleg, too many files) must not discard the whole
          // submission with a generic 500 — fold it into the same 400 re-render as every other
          // validation failure below, mirroring kontierung.js's identical uploadErr handling.
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
            const konto = alleKonten.find((k) => String(k.id) === pos.kontoId);
            if (!konto) {
              errors.push(`Position ${i + 1}: Bitte ein gültiges Konto wählen.`);
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
            aufgeloestePositionen.push({ ...pos, konto, betrag: pos.betrag.replace(',', '.'), mimetype });
          });

          if (errors.length > 0) {
            return res.status(400).render('spesen-neu', { alleKonten, values: { titel: req.body.titel || '', positionen }, errors });
          }

          // File I/O happens before the DB transaction (mirrors kontierung.js's Aufsplitten
          // handler): better-sqlite3-style synchronous transactions can't hold an await open.
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
                dateiname: pos.beleg.originalname,
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
              subject: istEskaliert
                ? 'Freigabeportal: Spesen-Position zur Prüfung — Selbsteinreichung durch Freigeber1'
                : 'Freigabeportal: Neue Spesen-Position zur Prüfung',
              text: `Eine Spesen-Position wartet auf deine Prüfung (Freigabe 1): ${job.dateiname}${
                istEskaliert ? `\n\nGrund für die Zuweisung an dich: ${job.freigabe1_eskalationsgrund}` : ''
              }\n\nBitte im Freigabeportal anmelden: ${config.publicBaseUrl}/spesen-freigabe1/${job.id}`,
              typ: 'zuweisung',
              jobId: job.id,
            });
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
