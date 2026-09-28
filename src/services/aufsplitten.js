import { mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mergeBelegInPdf, countBelegSeiten } from './belegAnhaengen.js';
import { loescheDateienStill } from './kkBelegDatei.js';
import {
  getJobById, createSplitJob, abschliessenFreigabe1, eskalierenFreigabe1, eskalierenFreigabe1AnAdmin, getEffectiveFreigeber2Id,
} from '../db/jobsRepo.js';
import { createFreigabe } from '../db/freigabenRepo.js';
import { getPersonById } from '../db/personenRepo.js';
import { getDebitorById } from '../db/debitorenRepo.js';
import { listDebitorIbansByDebitor } from '../db/debitorIbanRepo.js';
import { getConfigValue } from '../db/adminConfigRepo.js';
import { sendNotification, sendNotificationMitVertretung, resolveEmpfaenger } from './notify.js';

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
export const POSITION_PATTERN = /^[\u0020-\u007E\u00A0-\u00FFŒœŠšŽžŸ–—]*$/;

export function neuerDateipfad(jobsDir, quelldatei) {
  mkdirSync(jobsDir, { recursive: true });
  const endung = quelldatei.slice(quelldatei.lastIndexOf('.'));
  const zielPfad = join(jobsDir, `job-${Date.now()}-${Math.random().toString(36).slice(2)}${endung}`);
  copyFileSync(quelldatei, zielPfad);
  return zielPfad;
}

// Merges an uploaded Beleg (multer file) into the PDF at pdfPfad, in place — used once the
// caller has already confirmed the surrounding Kontierung/Aufsplitten action actually persisted,
// so a file that turns out not to apply (e.g. a 409 race) never mutates the PDF on disk.
export async function mergeBelegFuerJob(pdfPfad, { buffer }, mimetype) {
  const merged = await mergeBelegInPdf(readFileSync(pdfPfad), buffer, mimetype);
  writeFileSync(pdfPfad, merged);
}

export function pruefeIbanAbgleich(db, debitorId, qrIban) {
  const hinterlegte = listDebitorIbansByDebitor(db, debitorId);
  if (hinterlegte.length === 0) return { status: 'kein_abgleich' };
  return { status: hinterlegte.some((row) => row.iban === qrIban) ? 'match' : 'mismatch' };
}

// File I/O (including the async Beleg merge) happens before the caller's DB transaction,
// mirroring the "PDF work before BEGIN" pattern in freigabe2.js — better-sqlite3 has no
// real async transactions, so an await inside BEGIN/COMMIT would hold it open across the
// event loop. On the rare 409 (markJobAufgesplittet already run by another request), these
// freshly-copied files are simply orphaned — the same class of leftover-file risk the
// per-Zeile loop in erzeugeTeilJobs already accepts if a later Zeile throws mid-transaction.
export async function bereiteTeilDateienVor(config, job, teile) {
  const vorbereitet = [];
  // Scheitert ein späterer Teil (z. B. unlesbarer Beleg), werden die bis dahin angelegten
  // Kopien wieder entfernt, damit keine verwaisten Dateien zurückbleiben.
  const angelegt = [];
  try {
    for (const teil of teile) {
      const pdfPfad = neuerDateipfad(config.jobsDir, job.pdf_pfad);
      angelegt.push(pdfPfad);
      const thumbnailPfad = job.thumbnail_pfad ? neuerDateipfad(config.jobsDir, job.thumbnail_pfad) : null;
      angelegt.push(thumbnailPfad);
      // Die Seitenzahl des Belegs wird hier — und nur hier — festgehalten: mergeBelegFuerJob
      // hängt die Belegseiten direkt hinter die Rechnungsseiten, aber die spätere
      // Einzel-Freigabe-2 dieses Kindes hängt noch eigene Stempelseiten dahinter. Ohne diesen
      // Wert könnte der Gruppen-Merge die Belegseiten nachher nicht mehr von den Stempelseiten
      // unterscheiden (siehe haengeBelegSeitenAn in splitGruppenExport.js).
      let belegSeitenzahl = null;
      if (teil.beleg) {
        belegSeitenzahl = await countBelegSeiten(teil.beleg.buffer, teil.beleg.mimetype);
        await mergeBelegFuerJob(pdfPfad, teil.beleg, teil.beleg.mimetype);
      }
      vorbereitet.push({ ...teil, pdfPfad, thumbnailPfad, belegSeitenzahl });
    }
  } catch (err) {
    loescheDateienStill(...angelegt);
    throw err;
  }
  return vorbereitet;
}

// Must be called inside the caller's BEGIN/COMMIT, after markJobAufgesplittet succeeded.
// fremdKontoModus: 'pool' (Aufsplitten — foreign-Konto lines go back to the pool with a
// Hinweis-Konto) or 'freigeber1' (KK-Abgleich — assigned directly to that Konto's Freigeber1).
export function erzeugeTeilJobs(db, { job, teile, konten, person, ip, begruendung, fremdKontoModus = 'pool', istVertretung = false }) {
  const personId = person.churchtools_person_id;
  const ergebnis = { selbstFreigegeben: [], eskaliert: [], eskaliertAnAdmin: [], fremdeKonten: [], anFreigeber1: [] };
  for (const teil of teile) {
    const { pdfPfad, thumbnailPfad } = teil;
    const extra = { typ: teil.typ, beschreibung: teil.beschreibung, kkEigenbelegGrund: teil.kkEigenbelegGrund };
    const istEigenesKonto = konten.some((k) => k.id === teil.konto.id);

    if (!istEigenesKonto) {
      if (fremdKontoModus === 'freigeber1') {
        const kindId = createSplitJob(db, job, {
          pdfPfad, thumbnailPfad, kontoId: teil.konto.id, betrag: teil.betrag, zugewiesenAn: teil.konto.freigeber1_id,
          position: teil.position, belegSeitenzahl: teil.belegSeitenzahl, ...extra,
        });
        ergebnis.anFreigeber1.push({ id: kindId, konto: teil.konto });
      } else {
        const kindId = createSplitJob(db, job, {
          pdfPfad, thumbnailPfad, hinweisKontoId: teil.konto.id, betrag: teil.betrag,
          position: teil.position, belegSeitenzahl: teil.belegSeitenzahl, ...extra,
        });
        ergebnis.fremdeKonten.push({ id: kindId, konto: teil.konto });
      }
      continue;
    }

    const kindId = createSplitJob(db, job, {
      pdfPfad, thumbnailPfad, kontoId: teil.konto.id, betrag: teil.betrag, zugewiesenAn: personId,
      position: teil.position, belegSeitenzahl: teil.belegSeitenzahl, ...extra,
    });

    if (teil.interessenskonflikt) {
      const zeileEskaliertAnAdmin = Boolean(job.freigabe1_eskaliert_von || teil.konto.stellvertreter1_id === personId);
      createFreigabe(db, {
        jobId: kindId,
        personId,
        rolle: 'freigabe1_eskalation',
        zeitpunkt: new Date().toISOString(),
        ip,
        interessenskonflikt: true,
        kommentar: begruendung,
        eskaliertVon: job.freigabe1_eskaliert_von,
      });
      if (zeileEskaliertAnAdmin) {
        eskalierenFreigabe1AnAdmin(db, kindId, { eskaliertVon: personId, grund: begruendung });
        ergebnis.eskaliertAnAdmin.push({ id: kindId, konto: teil.konto });
      } else {
        eskalierenFreigabe1(db, kindId, {
          eskaliertVon: personId,
          grund: begruendung,
          stellvertreterId: teil.konto.stellvertreter1_id,
        });
        ergebnis.eskaliert.push({ id: kindId, konto: teil.konto });
      }
    } else {
      createFreigabe(db, {
        jobId: kindId, personId, rolle: 'freigeber1', zeitpunkt: new Date().toISOString(), ip,
        interessenskonflikt: false, kommentar: null, eskaliertVon: null,
        vertretungFuer: istVertretung ? job.zugewiesen_an : null,
      });
      abschliessenFreigabe1(db, kindId);
      ergebnis.selbstFreigegeben.push({ id: kindId, konto: teil.konto });
    }
  }
  return ergebnis;
}

export async function benachrichtigeNachAufsplitten(db, mailer, config, { job, ergebnis, person }) {
  for (const { id: kindId, konto } of ergebnis.selbstFreigegeben) {
    const kindJob = getJobById(db, kindId);
    const freigeber2 = getPersonById(db, getEffectiveFreigeber2Id(kindJob, konto));
    if (freigeber2) {
      await sendNotificationMitVertretung(db, mailer, {
        person: freigeber2,
        typ: 'zuweisung',
        jobId: kindJob.id,
        variablen: {
          jobDateiname: kindJob.dateiname,
          grund: 'Eine Rechnung wartet auf deine Freigabe 2.',
          link: `${config.publicBaseUrl}/freigabe2/${kindJob.id}`,
        },
      });
    }
  }

  for (const { id: kindId, konto } of ergebnis.eskaliert) {
    const stellvertreter1 = getPersonById(db, konto.stellvertreter1_id);
    if (stellvertreter1) {
      await sendNotification(db, mailer, {
        to: stellvertreter1.email,
        typ: 'zuweisung',
        jobId: kindId,
        variablen: {
          empfaengerName: `${stellvertreter1.vorname} ${stellvertreter1.nachname}`,
          jobDateiname: job.dateiname,
          grund: `Eine Rechnung wurde dir zur Kontierung übergeben, da ${person.vorname} ${person.nachname} einen Interessenskonflikt erklärt hat.`,
          link: `${config.publicBaseUrl}/kontierung/${kindId}`,
        },
      });
    }
  }

  for (const { id: kindId } of ergebnis.eskaliertAnAdmin) {
    const empfaenger = resolveEmpfaenger(db, config, 'gruppe:admin');
    for (const email of empfaenger) {
      await sendNotification(db, mailer, {
        to: email,
        typ: 'zuweisung',
        jobId: kindId,
        variablen: {
          empfaengerName: 'Portal-Admin-Team',
          jobDateiname: job.dateiname,
          grund: 'Eine Rechnung wurde an die Portal-Admin-Gruppe eskaliert, da auch die Stellvertretung einen Interessenskonflikt erklärt hat.',
          link: `${config.publicBaseUrl}/kontierung/${kindId}`,
        },
      });
    }
  }

  for (const { id: kindId, konto } of ergebnis.fremdeKonten) {
    const freigeber1 = getPersonById(db, konto.freigeber1_id);
    if (freigeber1) {
      await sendNotification(db, mailer, {
        to: freigeber1.email,
        typ: 'zuweisung',
        jobId: kindId,
        variablen: {
          empfaengerName: `${freigeber1.vorname} ${freigeber1.nachname}`,
          jobDateiname: job.dateiname,
          grund: `Eine Rechnung wurde mit dem Hinweis in den Pool zurückgelegt, dass sie vermutlich für dein Konto ${konto.kontonummer} — ${konto.bezeichnung} bestimmt ist.`,
          link: `${config.publicBaseUrl}/pool`,
        },
      });
    }
  }

  for (const { id: kindId, konto } of ergebnis.anFreigeber1) {
    const freigeber1 = getPersonById(db, konto.freigeber1_id);
    if (freigeber1) {
      await sendNotificationMitVertretung(db, mailer, {
        person: freigeber1,
        typ: 'zuweisung',
        jobId: kindId,
        variablen: {
          jobDateiname: job.dateiname,
          grund: `Eine Position einer Kreditkartenabrechnung wurde von ${person.vorname} ${person.nachname} deinem Konto ${konto.kontonummer} — ${konto.bezeichnung} zugeordnet und wartet auf deine Kontierung (Freigabe 1).`,
          link: `${config.publicBaseUrl}/kontierung/${kindId}`,
        },
      });
    }
  }
}

export async function pruefeIbanNachAufsplitten(db, mailer, config, { job, teile, konten, person, ip }) {
  // The main Kontierung submission runs this same check inline (see kontierung.js) — Aufsplitten
  // used to bypass it entirely, since splitting never used to touch job.debitor_id/qr_iban
  // at all. Run it once against the parent (which stays in the DB as a historical reference,
  // see markJobAufgesplittet), not per split child: the mismatch is a property of the
  // original invoice's IBAN vs. its Lieferant, not of any one Teil-Konto.
  if (job.qr_iban && job.debitor_id) {
    const debitor = getDebitorById(db, job.debitor_id);
    if (debitor) {
      const { status } = pruefeIbanAbgleich(db, debitor.id, job.qr_iban);
      if (status === 'mismatch') {
        createFreigabe(db, {
          jobId: job.id,
          personId: person.churchtools_person_id,
          rolle: 'iban_abweichung',
          zeitpunkt: new Date().toISOString(),
          ip,
          interessenskonflikt: false,
          kommentar: `QR-IBAN ${job.qr_iban} weicht von der/den für ${debitor.name} hinterlegten IBAN(s) ab.`,
          eskaliertVon: null,
        });
        const zusatzEmpfaenger = new Set(resolveEmpfaenger(db, config, getConfigValue(db, 'iban_abweichung_empfaenger')));
        zusatzEmpfaenger.add(person.email);
        for (const teil of teile) {
          if (!konten.some((k) => k.id === teil.konto.id)) continue;
          const freigeber1 = getPersonById(db, teil.konto.freigeber1_id);
          const freigeber2 = getPersonById(db, getEffectiveFreigeber2Id(job, teil.konto));
          if (freigeber1) zusatzEmpfaenger.add(freigeber1.email);
          if (freigeber2) zusatzEmpfaenger.add(freigeber2.email);
        }
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
      }
    }
  }
}
