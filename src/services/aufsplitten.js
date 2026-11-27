// Aufsplitten einer Rechnung auf mehrere Konten/Positionen (docs/rechnungs-workflow.md, "Aufsplitten"; der Kreditkarten-Abgleich
// nutzt dieselbe Mechanik, docs/kreditkarten-belege.md). Aus einem Elternvorgang werden eigenständige Teilvorgänge mit eigener
// Datei und eigener Freigabekette. Ablauf in der Route: 1) `bereiteTeilDateienVor` (Dateien, VOR der Transaktion),
// 2) in der Transaktion `markJobAufgesplittet` + `erzeugeTeilJobs`, 3) nach dem Commit `benachrichtigeNachAufsplitten`.

import { mkdirSync, copyFileSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { loescheDateienStill } from './kkBelegDatei.js';
import { pdfArbeit, PdfWorkerFehler } from './pdfArbeit.js';
import { BelegBildFehler } from './pdfFehler.js';
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
import { sendNotification, sendNotificationMitVertretung, resolveEmpfaenger, freigabe2AnAdminGrund } from './notify.js';

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

// Versandkosten gleichmässig auf `anzahl` Teile verteilen (in Rappen): jeder Anteil abgerundet, der Rest geht an den letzten Teil.
export function verteileVersandkosten(versandRappen, anzahl) {
  const anteil = Math.floor(versandRappen / anzahl);
  return Array.from({ length: anzahl }, (_, i) => (i === anzahl - 1 ? versandRappen - anteil * (anzahl - 1) : anteil));
}

// Position eines Teils mit Hinweis auf den enthaltenen Versandanteil (WinAnsi-sicher wie POSITION_PATTERN); ohne Anteil unverändert.
export function positionMitVersand(position, anteilRappen) {
  if (!anteilRappen) return position;
  const hinweis = `inkl. Versand ${(anteilRappen / 100).toFixed(2)}`;
  return position ? `${position} (${hinweis})` : hinweis;
}

// Kopiert die Quelldatei unter einem neuen, eindeutigen Namen nach `jobsDir`. @returns {string} Pfad der Kopie
export function neuerDateipfad(jobsDir, quelldatei) {
  mkdirSync(jobsDir, { recursive: true });
  const endung = quelldatei.slice(quelldatei.lastIndexOf('.'));
  const zielPfad = join(jobsDir, `job-${Date.now()}-${Math.random().toString(36).slice(2)}${endung}`);
  copyFileSync(quelldatei, zielPfad);
  return zielPfad;
}

// Beleg an das PDF eines bestehenden Vorgangs hängen (Kontierung und Ablehnung in kontierung.js; B2, Etappe 4). Das Zusammenführen
// läuft im PDF-Worker und damit über ein await. Damit nie eine Kontierung ohne ihren Beleg gespeichert wird (früher: COMMIT, danach
// erst das Zusammenführen – scheiterte es, blieb die Kontierung ohne Beleg und ohne Mails gespeichert), gilt diese Reihenfolge:
// 1) bereiteBelegAnhangVor – VOR der Transaktion: Vorgangs-PDF lesen, im Worker zusammenführen und die Belegseiten zählen,
//    Ergebnis in eine temporäre Datei neben dem PDF schreiben. Scheitert das (PdfWorkerFehler, unlesbarer Beleg), ist nichts gespeichert.
// 2) belegAnhangNochAktuell – IN der Transaktion: Während des Wartens auf den Worker kann eine andere Anfrage den Vorgang bearbeitet
//    oder sein PDF verändert haben (das await hebt den bisher durchgehend synchronen Ablauf von der Zuständigkeitsprüfung bis zum
//    COMMIT auf, auf den sich setKontierung/abschliessenFreigabe1 in jobsRepo.js verlassen). Dann ROLLBACK und 409.
// 3) uebernimmBelegAnhang – unmittelbar nach dem COMMIT und ohne await dazwischen: die temporäre Datei ersetzt das PDF per
//    renameSync (atomar im selben Verzeichnis). Die Belegseiten (addBelegSeiten) schreibt der Aufrufer schon in der Transaktion.
// verwirfBelegAnhang entfernt die temporäre Datei in allen anderen Fällen (Fehler, 409).

// Felder des Vorgangs, die sich zwischen Lesen des PDFs und COMMIT nicht ändern dürfen (Zustand, Zuständigkeit, PDF, Belegseiten).
const ANHANG_STAND_FELDER = [
  'status', 'zugewiesen_an', 'konto_id', 'pdf_pfad', 'beleg_seitenzahl', 'kreditkarte_id',
  'freigabe1_eskaliert_von', 'freigabe1_eskaliert_an_admin',
];

// Der Beleg liess sich nicht anhängen (beschädigtes oder unlesbares PDF/Bild, das erst beim Zusammenführen scheitert). Kein
// vorübergehender Fehler: die Route antwortet mit dem Formular und 422, gespeichert ist nichts. `cause` trägt den Originalfehler.
export class BelegAnhangFehler extends Error {
  constructor(cause) {
    super('Der Beleg konnte nicht angehängt werden: Die Datei ist beschädigt oder lässt sich nicht lesen. Es wurde nichts gespeichert. Bitte wähle eine andere Datei.', { cause });
    this.name = 'BelegAnhangFehler';
  }
}

/**
 * Schritt 1 (siehe oben): führt den Beleg im PDF-Worker (Spur interaktiv) mit dem PDF des Vorgangs zusammen.
 * Wirft PdfWorkerFehler (vorübergehend), BelegBildFehler (Bild zu gross/unlesbar) oder BelegAnhangFehler (jeder andere Fehler
 * des Zusammenführens); in allen Fällen ist keine Datei angelegt.
 * @param {object} job der Vorgang, so wie ihn die Route geladen hat (ohne await seit dem Laden)
 * @param {{buffer: Buffer}} beleg hochgeladene Datei (multer)
 * @param {'application/pdf'|'image/png'|'image/jpeg'} mimetype
 * @returns {Promise<{pdfPfad: string, tempPfad: string, original: Buffer, belegSeiten: number, stand: object}>}
 */
export async function bereiteBelegAnhangVor(job, { buffer }, mimetype) {
  const original = readFileSync(job.pdf_pfad);
  const stand = Object.fromEntries(ANHANG_STAND_FELDER.map((feld) => [feld, job[feld] ?? null]));
  let ergebnis;
  try {
    ergebnis = await pdfArbeit().ausfuehren('belegAnhaengen', [original, buffer, mimetype], { spur: 'interaktiv' });
  } catch (err) {
    if (err instanceof PdfWorkerFehler || err instanceof BelegBildFehler) throw err;
    throw new BelegAnhangFehler(err);
  }
  const { pdf, belegSeiten } = ergebnis;
  const tempPfad = `${job.pdf_pfad}.beleg-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tempPfad, pdf);
  return { pdfPfad: job.pdf_pfad, tempPfad, original, belegSeiten, stand };
}

/**
 * Schritt 2: true, wenn Vorgang und PDF noch genau so sind wie beim Lesen in bereiteBelegAnhangVor. Synchron, innerhalb der
 * Transaktion aufrufen – bis zum COMMIT und zur Übernahme kann sich dann nichts mehr dazwischenschieben.
 */
export function belegAnhangNochAktuell(db, jobId, anhang) {
  const aktuell = getJobById(db, jobId);
  if (!aktuell) return false;
  if (ANHANG_STAND_FELDER.some((feld) => (aktuell[feld] ?? null) !== anhang.stand[feld])) return false;
  try {
    return readFileSync(anhang.pdfPfad).equals(anhang.original);
  } catch {
    return false;
  }
}

/**
 * Schritt 3: ersetzt das PDF durch das zusammengeführte (synchron, direkt nach dem COMMIT). Ein Fehler hier (nur bei einem
 * Dateisystemproblem denkbar: die temporäre Datei liegt im selben Verzeichnis) wird laut protokolliert, weil die Kontierung dann
 * schon gespeichert ist; die temporäre Datei bleibt für eine Wiederherstellung von Hand liegen.
 */
export function uebernimmBelegAnhang(anhang) {
  try {
    renameSync(anhang.tempPfad, anhang.pdfPfad);
  } catch (err) {
    console.error(`Beleg anhängen: ${anhang.tempPfad} konnte nach dem Speichern nicht nach ${anhang.pdfPfad} übernommen werden (${err.message}).`);
    throw err;
  }
}

/** Entfernt die temporäre Datei eines nicht übernommenen Anhangs (null erlaubt). */
export function verwirfBelegAnhang(anhang) {
  if (anhang) loescheDateienStill(anhang.tempPfad);
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
      // Die Seitenzahl des Belegs wird hier — und nur hier — festgehalten: das Zusammenführen
      // hängt die Belegseiten direkt hinter die Rechnungsseiten, aber die spätere
      // Einzel-Freigabe-2 dieses Kindes hängt noch eigene Stempelseiten dahinter. Ohne diesen
      // Wert könnte der Gruppen-Merge die Belegseiten nachher nicht mehr von den Stempelseiten
      // unterscheiden (siehe haengeBelegSeitenAn in splitGruppenExport.js).
      let belegSeitenzahl = null;
      // B2, Etappe 4: Zusammenführen und Zählen im PDF-Worker (ein Auftrag). Scheitert er (PdfWorkerFehler oder unlesbarer
      // Beleg), entfernt der catch-Block unten alle Kopien; der Aufrufer antwortet bei PdfWorkerFehler mit 503.
      if (teil.beleg) {
        const { pdf, belegSeiten } = await pdfArbeit().ausfuehren(
          'belegAnhaengen', [readFileSync(pdfPfad), teil.beleg.buffer, teil.beleg.mimetype], { spur: 'interaktiv' },
        );
        writeFileSync(pdfPfad, pdf);
        belegSeitenzahl = belegSeiten;
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
    // Splitkinder haben keinen eigenen Konfliktverlauf, abschliessenFreigabe1 gibt sie aber an die
    // Admin-Gruppe, wenn die aufsplittende Person auch Freigeber 2 des Kontos ist und keine
    // Stellvertretung 2 übernehmen kann (Vier-Augen-Umleitung).
    if (kindJob.freigabe2_eskaliert_an_admin) {
      for (const email of resolveEmpfaenger(db, config, 'gruppe:admin')) {
        await sendNotification(db, mailer, {
          to: email,
          typ: 'zuweisung',
          jobId: kindJob.id,
          variablen: {
            empfaengerName: 'Portal-Admin-Team',
            jobDateiname: kindJob.dateiname,
            grund: freigabe2AnAdminGrund(kindJob),
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
