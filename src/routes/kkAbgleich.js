import { Router } from 'express';
import multer from 'multer';
import { readFileSync, existsSync } from 'node:fs';
import { getKreditkarteById } from '../db/kreditkartenRepo.js';
import { listOffeneKkBelegeFuerKarte, getKkBelegById, ordneKkBelegZu, createKkBeleg, logKkBelegEreignis } from '../db/kkBelegeRepo.js';
import { listKonten, getKontoById } from '../db/kontenRepo.js';
import { listDebitoren, getDebitorById } from '../db/debitorenRepo.js';
import { getPersonById } from '../db/personenRepo.js';
import { buildSignedDownloadUrl, PDF_PREVIEW_TTL_SECONDS } from '../services/downloadUrl.js';
import { buildAuditLog } from '../services/auditLog.js';
import { ladeKontierbarenJob, ladeKontenFuerJob } from '../services/kontierungZugriff.js';
import { markJobAufgesplittet, setJobBetrag, setKkAbrechnungKopfdaten } from '../db/jobsRepo.js';
import { createFreigabe } from '../db/freigabenRepo.js';
import { detectBelegMimetype, countBelegSeiten } from '../services/belegAnhaengen.js';
import { istAktiveVertretungFuer } from '../services/vertretung.js';
import { bereiteTeilDateienVor, erzeugeTeilJobs, benachrichtigeNachAufsplitten, pruefeIbanNachAufsplitten, POSITION_PATTERN } from '../services/aufsplitten.js';
import { speichereKkBelegDatei, loescheDateienStill, KK_BETRAG_PATTERN, normalisiereBetrag } from '../services/kkBelegDatei.js';

const MAX_BELEG_SIZE = 20 * 1024 * 1024;
const MAX_ZEILEN = 100;
const POSITION_AUS_BESCHREIBUNG_MAX = 80;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BELEG_SIZE, files: MAX_ZEILEN } });

function personLabel(db, id) {
  const p = id ? getPersonById(db, id) : null;
  return p ? `${p.vorname} ${p.nachname}` : 'Unbekannt';
}

export function createKkAbgleichRouter({ db, config, mailer, csrfProtection = (req, res, next) => next() }) {
  const router = Router();

  function ladeAbrechnung(req, res) {
    const job = ladeKontierbarenJob(db, config, req, res);
    if (!job) return null;
    if (!job.kreditkarte_id) {
      res.status(409).render('error', { message: 'Diese Rechnung ist keiner Kreditkarte zugeordnet.' });
      return null;
    }
    return job;
  }

  function offeneBelege(karteId) {
    return listOffeneKkBelegeFuerKarte(db, karteId).map((b) => ({
      ...b,
      gekauftVonName: personLabel(db, b.gekauft_von),
      hochgeladenVonName: personLabel(db, b.hochgeladen_von),
    }));
  }

  function renderSeite(req, res, status, job, { werte, zeilen, errors }) {
    const karte = getKreditkarteById(db, job.kreditkarte_id);
    res.status(status).render('kk-abgleich', {
      job,
      karte,
      belege: offeneBelege(karte.id),
      alleKonten: listKonten(db),
      eigeneKontoIds: ladeKontenFuerJob(db, req, job).map((k) => k.id),
      debitoren: listDebitoren(db),
      previewUrl: buildSignedDownloadUrl(config, job.id, PDF_PREVIEW_TTL_SECONDS),
      werte,
      zeilen,
      errors,
      auditLog: buildAuditLog(db, job.id),
    });
  }

  router.get('/:id/kk-abgleich', (req, res) => {
    const job = ladeAbrechnung(req, res);
    if (!job) return;
    renderSeite(req, res, 200, job, {
      werte: {
        gesamtbetrag: job.betrag || job.qr_betrag || '',
        debitorId: job.debitor_id ? String(job.debitor_id) : '',
        rechnungsnummer: job.rechnungsnummer || '',
        zahlungsziel: job.zahlungsziel || '',
        begruendung: '',
      },
      zeilen: [],
      errors: [],
    });
  });

  const ARTEN = new Set(['beleg', 'nachreichen', 'eigenbeleg', 'gebuehr']);
  const DATUM_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

  class AbgleichKonflikt extends Error {}

  router.post('/:id/kk-abgleich', (req, res, next) => {
    upload.any()(req, res, (uploadErr) => {
      csrfProtection(req, res, async (csrfErr) => {
        if (csrfErr) return next(csrfErr);
        const angelegteDateien = [];
        try {
          const job = ladeAbrechnung(req, res);
          if (!job) return;
          const konten = ladeKontenFuerJob(db, req, job);
          const b = req.body;
          const werte = {
            gesamtbetrag: (b.gesamtbetrag || '').trim(),
            debitorId: b.debitorId || '',
            rechnungsnummer: (b.rechnungsnummer || '').trim(),
            zahlungsziel: (b.zahlungsziel || '').trim(),
            begruendung: (b.begruendung || '').trim(),
          };
          const arr = (name) => [].concat(b[name] ?? []);
          const arten = arr('zeileArt');
          const zeilen = arten.map((art, i) => ({
            art,
            belegId: arr('zeileBelegId')[i] || '',
            kontoId: arr('zeileKontoId')[i] || '',
            betrag: (arr('zeileBetrag')[i] || '').trim(),
            position: (arr('zeilePosition')[i] || '').trim(),
            beschreibung: (arr('zeileBeschreibung')[i] || '').trim(),
            grund: (arr('zeileGrund')[i] || '').trim(),
            interessenskonflikt: arr('zeileKonflikt')[i] === 'true',
          }));

          const dateiByIndex = new Map();
          const errors = [];
          if (uploadErr) errors.push(uploadErr.code === 'LIMIT_FILE_SIZE' ? 'Eine Datei darf höchstens 20 MB gross sein.' : 'Fehler beim Datei-Upload.');
          for (const file of req.files || []) {
            const m = /^zeileDatei_(\d+)$/.exec(file.fieldname);
            if (!m) continue;
            const mimetype = detectBelegMimetype(file.buffer);
            if (!mimetype || mimetype !== file.mimetype) {
              errors.push('Jede nachgereichte Datei muss eine PDF-, PNG- oder JPEG-Datei sein.');
              continue;
            }
            dateiByIndex.set(Number(m[1]), { buffer: file.buffer, mimetype });
          }

          if (!KK_BETRAG_PATTERN.test(werte.gesamtbetrag)) errors.push('Bitte ein gültiges Abrechnungstotal angeben.');
          if (werte.zahlungsziel && !DATUM_PATTERN.test(werte.zahlungsziel)) errors.push('Zahlungsziel ist kein gültiges Datum.');
          const debitor = werte.debitorId ? getDebitorById(db, werte.debitorId) : null;
          if (werte.debitorId && !debitor) errors.push('Bitte einen gültigen Kartenherausgeber wählen.');
          if (zeilen.length === 0) errors.push('Mindestens eine Position ist nötig.');

          // Nachgereichte Dateien müssen sich öffnen lassen, sonst scheitert erst die Dateiarbeit
          // (500 statt Hinweis im Formular).
          const unlesbareDateien = new Set();
          for (const [i, datei] of dateiByIndex) {
            try {
              await countBelegSeiten(datei.buffer, datei.mimetype);
            } catch {
              unlesbareDateien.add(i);
            }
          }

          const teile = [];
          const verwendeteBelege = new Set();
          let belegKonflikt = false;
          zeilen.forEach((z, i) => {
            const nr = `Position ${i + 1}`;
            if (!ARTEN.has(z.art)) return errors.push(`${nr}: unbekannte Art.`);
            const konto = getKontoById(db, Number(z.kontoId));
            if (!konto || !konto.aktiv) return errors.push(`${nr}: Bitte ein gültiges Konto wählen.`);
            if (!KK_BETRAG_PATTERN.test(z.betrag)) return errors.push(`${nr}: Bitte einen gültigen Betrag angeben.`);
            const betragSigniert = normalisiereBetrag(z.betrag);
            if (Number(betragSigniert) === 0) return errors.push(`${nr}: Betrag darf nicht 0 sein.`);
            if (z.position && !POSITION_PATTERN.test(z.position)) return errors.push(`${nr}: Position enthält Zeichen, die nicht gestempelt werden können.`);
            // Bei Beleg-Zeilen ist die Beschreibung schreibgeschützt (kommt vom Beleg) -- dort nicht
            // prüfen, sonst liesse sich ein Altbeleg nie mehr abgleichen.
            if (z.art !== 'beleg' && z.beschreibung && !POSITION_PATTERN.test(z.beschreibung)) return errors.push(`${nr}: Beschreibung enthält Zeichen, die nicht gestempelt werden können.`);
            const teil = {
              konto,
              // Eine Gutschrift hat im Portal immer einen positiven Betrag, die Bedeutung trägt `typ`.
              // Der signierte Wert bleibt für die Summenprüfung und den kk_belege-Eintrag erhalten.
              betrag: Math.abs(Number(betragSigniert)).toFixed(2),
              betragSigniert,
              interessenskonflikt: z.interessenskonflikt,
              position: z.position || null,
              beschreibung: z.beschreibung || null,
              typ: Number(betragSigniert) < 0 ? 'gutschrift' : 'rechnung',
              beleg: null,
              kkBelegId: null,
              nachreichen: null,
              kkEigenbelegGrund: null,
            };
            if (z.art === 'beleg') {
              const beleg = getKkBelegById(db, Number(z.belegId));
              if (!beleg || beleg.kreditkarte_id !== job.kreditkarte_id) return errors.push(`${nr}: Der Beleg gehört nicht zu dieser Karte.`);
              // Inzwischen verworfen/zugeordnet (anderer Tab, andere Person): kein Eingabefehler,
              // sondern ein Konflikt -- 409 wie der Transaktions-Check weiter unten.
              if (beleg.status !== 'offen' || !beleg.pdf_pfad || !existsSync(beleg.pdf_pfad)) {
                belegKonflikt = true;
                return;
              }
              if (verwendeteBelege.has(beleg.id)) return errors.push(`${nr}: Derselbe Beleg ist mehrfach ausgewählt.`);
              verwendeteBelege.add(beleg.id);
              teil.kkBelegId = beleg.id;
              teil.beschreibung = teil.beschreibung || beleg.beschreibung;
              teil.beleg = { buffer: readFileSync(beleg.pdf_pfad), mimetype: 'application/pdf' };
            } else if (z.art === 'nachreichen') {
              const datei = dateiByIndex.get(i);
              if (unlesbareDateien.has(i)) return errors.push(`${nr}: Die Datei kann nicht gelesen werden.`);
              if (!datei) return errors.push(`${nr}: Bitte eine Datei auswählen.`);
              if (!z.beschreibung) return errors.push(`${nr}: Bitte eine Beschreibung angeben.`);
              teil.beleg = datei;
              teil.nachreichen = datei;
            } else if (z.art === 'eigenbeleg') {
              if (!z.grund) return errors.push(`${nr}: Ohne Beleg ist eine Begründung Pflicht.`);
              if (!POSITION_PATTERN.test(z.grund)) return errors.push(`${nr}: Begründung enthält Zeichen, die nicht gestempelt werden können.`);
              teil.kkEigenbelegGrund = z.grund;
            } else {
              teil.kkEigenbelegGrund = 'Gebühr/Zins';
            }
            // Spec §5.2: ohne erfasste Position wird die Beschreibung (des Belegs bzw. der Zeile)
            // übernommen -- nur wenn stempelbar, sonst scheitert später der Stempel.
            if (!teil.position && teil.beschreibung && POSITION_PATTERN.test(teil.beschreibung)) {
              teil.position = teil.beschreibung.slice(0, POSITION_AUS_BESCHREIBUNG_MAX);
            }
            teile.push(teil);
          });

          if (belegKonflikt) {
            return res.status(409).render('error', { message: 'Ein Beleg wurde inzwischen anderweitig verwendet oder verworfen. Bitte die Seite neu laden.' });
          }

          if (errors.length === 0) {
            const summe = teile.reduce((s, t) => s + Number(t.betragSigniert), 0);
            const total = Number(normalisiereBetrag(werte.gesamtbetrag));
            if (Math.abs(summe - total) > 0.005) errors.push(`Die Summe der Positionen (${summe.toFixed(2)}) muss dem Abrechnungstotal (${total.toFixed(2)}) entsprechen.`);
          }
          const hatKonflikt = teile.some((t) => t.interessenskonflikt && konten.some((k) => k.id === t.konto.id));
          if (hatKonflikt && !werte.begruendung) errors.push('Bei einem Interessenskonflikt ist eine Begründung Pflicht.');

          if (errors.length > 0) {
            return renderSeite(req, res, 400, job, { werte, zeilen, errors });
          }

          // Dateiarbeit vor der Transaktion (siehe aufsplitten.js). Nachgereichte Belege werden
          // zusätzlich als eigene kk_belege-Datei abgelegt, damit sie wie jeder andere Beleg
          // nachvollziehbar bleiben.
          let vorbereitet;
          try {
            for (const teil of teile) {
              if (teil.nachreichen) {
                teil.nachreichDatei = await speichereKkBelegDatei(config, teil.nachreichen.buffer, teil.nachreichen.mimetype);
                angelegteDateien.push(teil.nachreichDatei.pdfPfad, teil.nachreichDatei.thumbnailPfad);
              }
            }
            vorbereitet = await bereiteTeilDateienVor(config, job, teile);
            for (const t of vorbereitet) angelegteDateien.push(t.pdfPfad, t.thumbnailPfad);
          } catch (err) {
            loescheDateienStill(...angelegteDateien);
            throw err;
          }

          const personId = req.currentPerson.churchtools_person_id;
          const total = normalisiereBetrag(werte.gesamtbetrag);
          let ergebnis;
          db.exec('BEGIN');
          try {
            setJobBetrag(db, job.id, total);
            setKkAbrechnungKopfdaten(db, job.id, {
              debitorId: debitor?.id ?? job.debitor_id,
              lieferant: debitor?.name ?? job.lieferant,
              rechnungsnummer: werte.rechnungsnummer || job.rechnungsnummer,
              zahlungsziel: werte.zahlungsziel || job.zahlungsziel,
            });
            if (!markJobAufgesplittet(db, job.id)) throw new AbgleichKonflikt('Diese Abrechnung wurde inzwischen bereits bearbeitet.');
            const parent = { ...job, betrag: total, ...db.prepare('SELECT debitor_id, lieferant, rechnungsnummer, zahlungsziel FROM jobs WHERE id = ?').get(job.id) };
            ergebnis = erzeugeTeilJobs(db, {
              job: parent,
              teile: vorbereitet,
              konten,
              person: req.currentPerson,
              ip: req.ip,
              begruendung: werte.begruendung,
              fremdKontoModus: 'freigeber1',
              istVertretung: !job.freigabe1_eskaliert_an_admin && istAktiveVertretungFuer(db, personId, job.zugewiesen_an),
            });
            // erzeugeTeilJobs legt die Kinder in Eingabereihenfolge an; die IDs aller Ergebnislisten
            // zusammen, aufsteigend sortiert, entsprechen deshalb 1:1 der Reihenfolge von `vorbereitet`.
            const kindIds = [
              ...ergebnis.selbstFreigegeben, ...ergebnis.eskaliert, ...ergebnis.eskaliertAnAdmin, ...ergebnis.fremdeKonten, ...ergebnis.anFreigeber1,
            ].map((e) => e.id).sort((a, c) => a - c);
            if (kindIds.length !== vorbereitet.length) throw new Error('Teil-Job-Anzahl stimmt nicht');
            vorbereitet.forEach((teil, i) => {
              const kindId = kindIds[i];
              if (teil.kkBelegId) {
                if (!ordneKkBelegZu(db, teil.kkBelegId, { kreditkarteId: job.kreditkarte_id, jobId: kindId })) {
                  throw new AbgleichKonflikt('Ein Beleg wurde inzwischen anderweitig verwendet oder verworfen. Bitte die Seite neu laden.');
                }
                logKkBelegEreignis(db, { belegId: teil.kkBelegId, personId, aktion: 'kk_beleg_zugeordnet', kommentar: `Job #${kindId}` });
              } else if (teil.nachreichDatei) {
                const belegId = createKkBeleg(db, {
                  kreditkarteId: job.kreditkarte_id, hochgeladenVon: personId, gekauftVon: personId, quelle: 'abgleich',
                  pdfPfad: teil.nachreichDatei.pdfPfad, thumbnailPfad: teil.nachreichDatei.thumbnailPfad,
                  betrag: teil.betragSigniert, kaufdatum: null, beschreibung: teil.beschreibung, kontoId: teil.konto.id, status: 'zugeordnet',
                });
                db.prepare('UPDATE kk_belege SET zugeordnet_job_id = ?, zugeordnet_am = ? WHERE id = ?').run(kindId, new Date().toISOString(), belegId);
                logKkBelegEreignis(db, { belegId, personId, aktion: 'kk_beleg_zugeordnet', kommentar: `beim Abgleich nachgereicht, Job #${kindId}` });
              }
            });
            const anzahl = (art) => zeilen.filter((z) => z.art === art).length;
            createFreigabe(db, {
              jobId: job.id, personId, rolle: 'kk_abgleich', zeitpunkt: new Date().toISOString(), ip: req.ip, interessenskonflikt: false,
              kommentar: `${zeilen.length} Positionen: ${anzahl('beleg')} Beleg, ${anzahl('nachreichen')} nachgereicht, ${anzahl('eigenbeleg')} ohne Beleg, ${anzahl('gebuehr')} Gebühr/Zins`,
              eskaliertVon: null,
            });
            db.exec('COMMIT');
          } catch (err) {
            db.exec('ROLLBACK');
            loescheDateienStill(...angelegteDateien);
            if (err instanceof AbgleichKonflikt) return res.status(409).render('error', { message: err.message });
            throw err;
          }

          await benachrichtigeNachAufsplitten(db, mailer, config, { job, ergebnis, person: req.currentPerson });
          await pruefeIbanNachAufsplitten(db, mailer, config, { job, teile: vorbereitet, konten, person: req.currentPerson, ip: req.ip });
          res.redirect('/pool');
        } catch (err) {
          next(err);
        }
      });
    });
  });

  return router;
}
