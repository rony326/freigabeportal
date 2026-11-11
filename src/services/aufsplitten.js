// Aufsplitten einer Rechnung auf mehrere Konten/Positionen (docs/rechnungs-workflow.md, "Aufsplitten"; der Kreditkarten-Abgleich
// nutzt dieselbe Mechanik, docs/kreditkarten-belege.md). Aus einem Elternvorgang werden eigenständige Teilvorgänge mit eigener
// Datei und eigener Freigabekette. Ablauf in der Route: 1) `bereiteTeilDateienVor` (Dateien, VOR der Transaktion),
// 2) in der Transaktion `markJobAufgesplittet` + `erzeugeTeilJobs`, 3) nach dem Commit `benachrichtigeNachAufsplitten`.

import { mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mergeBelegInPdf, countBelegSeiten } from './belegAnhaengen.js';
import { loescheDateienStill } from './kkBelegDatei.js';
import {
  getJobById, createSplitJob, abschliessenFreigabe1, eskalierenFreigabe1, eskalierenFreigabe1AnAdmin, getEffectiveFreigeber2Id,
} from '../db/jobsRepo.js';
import { ausschlussGrundFuerEskalationsziel, grundMitAusschluss, adminEskalationsText } from './eskalationsZiel.js';
import { createFreigabe } from '../db/freigabenRepo.js';
import { getPersonById } from '../db/personenRepo.js';
import { getKreditorById } from '../db/kreditorenRepo.js';
import { listKreditorIbansByKreditor } from '../db/kreditorIbanRepo.js';
import { sendeAuffaelligkeitenWarnung } from './auffaelligkeitenWarnung.js';
import { ibanBefund } from './betrugspruefung.js';
import { sendNotification, sendNotificationMitVertretung, resolveEmpfaenger, FREIGABE2_AN_ADMIN_GRUND } from './notify.js';

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
// Erlaubte Zeichen für das Positionsfeld einer Aufteilungszeile (WinAnsi-sicher, siehe Begründung oben).
export const POSITION_PATTERN = /^[\u0020-\u007E\u00A0-\u00FFŒœŠšŽžŸ–—]*$/;

// Kopiert die Quelldatei unter einem neuen, eindeutigen Namen nach `jobsDir`. @returns {string} Pfad der Kopie
export function neuerDateipfad(jobsDir, quelldatei) {
  mkdirSync(jobsDir, { recursive: true });
  const endung = quelldatei.slice(quelldatei.lastIndexOf('.'));
  const zielPfad = join(jobsDir, `job-${Date.now()}-${Math.random().toString(36).slice(2)}${endung}`);
  copyFileSync(quelldatei, zielPfad);
  return zielPfad;
}

// Fügt einen hochgeladenen Beleg (multer-Datei) direkt in das PDF unter pdfPfad ein — wird erst genutzt, nachdem der Aufrufer
// bestätigt hat, dass die umgebende Kontierung/das Aufsplitten tatsächlich gespeichert wurde; eine Datei, die sich dann doch
// als unpassend herausstellt (z. B. ein 409-Wettlauf), verändert so nie das PDF auf der Platte.
export async function mergeBelegFuerJob(pdfPfad, { buffer }, mimetype) {
  const merged = await mergeBelegInPdf(readFileSync(pdfPfad), buffer, mimetype);
  writeFileSync(pdfPfad, merged);
}

// Vergleicht die per QR gelesene IBAN mit den hinterlegten IBANs des Kreditors. @returns {{status: 'kein_abgleich'|'match'|'mismatch'}}
export function pruefeIbanAbgleich(db, kreditorId, qrIban) {
  const hinterlegte = listKreditorIbansByKreditor(db, kreditorId);
  if (hinterlegte.length === 0) return { status: 'kein_abgleich' };
  return { status: hinterlegte.some((row) => row.iban === qrIban) ? 'match' : 'mismatch' };
}

// Datei-I/O (auch das asynchrone Zusammenführen des Belegs) passiert vor der Transaktion des Aufrufers, wie beim Muster
// "PDF-Arbeit vor BEGIN" in freigabe2.js — node:sqlite kennt keine echten asynchronen Transaktionen, ein await innerhalb von
// BEGIN/COMMIT würde sie über die Ereignisschleife hinweg offen halten. Im seltenen 409-Fall (markJobAufgesplittet lief schon
// durch eine andere Anfrage) bleiben diese frisch kopierten Dateien einfach verwaist zurück — dieselbe Art von
// Restdatei-Risiko, die die Schleife je Zeile in erzeugeTeilJobs ohnehin in Kauf nimmt, wenn eine spätere Zeile mitten in der
// Transaktion wirft.
/**
 * Legt je Teil eine eigene Kopie von PDF (und Thumbnail) an und fügt einen optionalen Beleg an.
 * @returns {Promise<object[]>} die Teile, ergänzt um `pdfPfad`, `thumbnailPfad`, `belegSeitenzahl`
 */
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

// Muss innerhalb des BEGIN/COMMIT des Aufrufers laufen, nachdem markJobAufgesplittet erfolgreich war.
// fremdKontoModus: 'pool' (Aufsplitten — Zeilen auf ein fremdes Konto gehen mit Hinweis-Konto zurück in den Pool)
// oder 'freigeber1' (KK-Abgleich — direkt dem Freigeber 1 dieses Kontos zugewiesen).
// Je Teil: eigenes Konto → die Person gibt Freigabe 1 selbst (oder erklärt einen Interessenskonflikt → Eskalation);
// fremdes Konto → siehe fremdKontoModus. @returns {object} Listen der angelegten Teilvorgänge nach Behandlung
// (selbstFreigegeben, eskaliert, eskaliertAnAdmin, fremdeKonten, anFreigeber1)
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
      // Geprüft gegen den Verlauf der Originalrechnung (job), nicht des frischen Teils: ein dort
      // erklärter Konflikt gehört weiterhin zur Rechnung.
      const sv1Ausschluss = job.freigabe1_eskaliert_von
        ? null
        : ausschlussGrundFuerEskalationsziel(db, job, { stufe: 1, zielId: teil.konto.stellvertreter1_id, meldenderId: personId });
      const zeileEskaliertAnAdmin = Boolean(job.freigabe1_eskaliert_von || sv1Ausschluss);
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
        eskalierenFreigabe1AnAdmin(db, kindId, { eskaliertVon: personId, grund: grundMitAusschluss(begruendung, sv1Ausschluss) });
        ergebnis.eskaliertAnAdmin.push({ id: kindId, konto: teil.konto, ausschluss: sv1Ausschluss });
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

// Verschickt nach dem Commit die Mails zu allen angelegten Teilvorgängen (nächste zuständige Person je Behandlung).
export async function benachrichtigeNachAufsplitten(db, mailer, config, { job, ergebnis, person }) {
  for (const { id: kindId, konto } of ergebnis.selbstFreigegeben) {
    const kindJob = getJobById(db, kindId);
    // Splitkinder haben keinen eigenen Konfliktverlauf, abschliessenFreigabe1 lässt sie deshalb
    // nie an die Admin-Gruppe gehen. Geprüft wird trotzdem wie in kontierung.js/spesenFreigabe1.js.
    if (kindJob.freigabe2_eskaliert_an_admin) {
      for (const email of resolveEmpfaenger(db, config, 'gruppe:admin')) {
        await sendNotification(db, mailer, {
          to: email,
          typ: 'zuweisung',
          jobId: kindJob.id,
          variablen: {
            empfaengerName: 'Portal-Admin-Team',
            jobDateiname: kindJob.dateiname,
            grund: FREIGABE2_AN_ADMIN_GRUND,
            link: `${config.publicBaseUrl}/freigabe2/${kindJob.id}`,
          },
        });
      }
      continue;
    }
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

  for (const { id: kindId, ausschluss } of ergebnis.eskaliertAnAdmin) {
    const empfaenger = resolveEmpfaenger(db, config, 'gruppe:admin');
    for (const email of empfaenger) {
      await sendNotification(db, mailer, {
        to: email,
        typ: 'zuweisung',
        jobId: kindId,
        variablen: {
          empfaengerName: 'Portal-Admin-Team',
          jobDateiname: job.dateiname,
          grund: adminEskalationsText('Eine Rechnung', ausschluss),
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

// Alle Kind-IDs eines erzeugeTeilJobs-Ergebnisses, aufsteigend. erzeugeTeilJobs legt die Kinder in
// Eingabereihenfolge an; die Reihenfolge entspricht deshalb 1:1 der der Teile.
// (Reihenfolge der Kinder entspricht der der Teile, siehe Kommentar.)
export function alleKindIds(ergebnis) {
  return [
    ...ergebnis.selbstFreigegeben, ...ergebnis.eskaliert, ...ergebnis.eskaliertAnAdmin, ...ergebnis.fremdeKonten, ...ergebnis.anFreigeber1,
  ].map((e) => e.id).sort((a, b) => a - b);
}

// Nur noch für den Kreditkarten-Abgleich: das Aufsplitten selbst prüft vorher per Prüf-Popup
// (kontierung.js). Der Abgleich hat kein Popup, deshalb bleibt hier die nachträgliche Warnung mit
// dem IBAN-Befund aus betrugspruefung.js und dem iban_abweichung-Eintrag am Elternjob.
// (Siehe Kommentar oben.) Ergänzt den iban_abweichung-Verlaufseintrag und verschickt die Warnmail.
export async function pruefeIbanNachKkAbgleich(db, mailer, config, { job, teile, konten, person, ip }) {
  if (!job.qr_iban || !job.kreditor_id) return;
  const kreditor = getKreditorById(db, job.kreditor_id);
  if (!kreditor) return;
  // Wie bisher unabhängig von der Zahlungsart (Kartenherausgeber zieht meist per Lastschrift ein);
  // ohne hinterlegte IBAN kein Abgleich.
  if (listKreditorIbansByKreditor(db, kreditor.id).length === 0) return;
  const befund = ibanBefund(db, kreditor, job.qr_iban);
  if (!befund) return;
  const befunde = [befund];
  createFreigabe(db, {
    jobId: job.id,
    personId: person.churchtools_person_id,
    rolle: 'iban_abweichung',
    zeitpunkt: new Date().toISOString(),
    ip,
    interessenskonflikt: false,
    kommentar: `QR-IBAN ${job.qr_iban} weicht von der/den für ${kreditor.name} hinterlegten IBAN(s) ab.`,
    eskaliertVon: null,
  });
  const freigeberIds = [];
  for (const teil of teile) {
    if (!konten.some((k) => k.id === teil.konto.id)) continue;
    freigeberIds.push(teil.konto.freigeber1_id, getEffectiveFreigeber2Id(job, teil.konto));
  }
  await sendeAuffaelligkeitenWarnung(db, mailer, config, {
    job, kreditor, befunde, bemerkung: null, person, freigeberIds,
    link: `${config.publicBaseUrl}/kontierung/${job.id}`,
  });
}
