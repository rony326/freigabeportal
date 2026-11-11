// Zusammenführen einer vollständig freigegebenen Splitgruppe zu EINEM gestempelten, zeitgestempelten Archiv-PDF (docs/rechnungs-workflow.md,
// "Splitgruppen-Export"; Aufrufer: Abschluss von Freigabe 2, Löschung einer blockierenden Zeile und der Cron-Job split-gruppen-nachholen).

import { readFileSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { getJobById, pruefeSplitGruppenVollstaendigkeit, markGruppeExportiert } from '../db/jobsRepo.js';
import { getKontoById } from '../db/kontenRepo.js';
import { getPersonById } from '../db/personenRepo.js';
import { listFreigabenByJob } from '../db/freigabenRepo.js';
import { getConfigValue } from '../db/adminConfigRepo.js';
import { stampGruppenDokument } from './pdfStamp.js';
import { setZeitstempelMitNachweis } from './zeitstempel.js';
import { speichereTsaNachweis } from './tsaNachweis.js';
import { writeFinalDocument } from './finalDocument.js';
import { tsaTrustOptions } from './tsaTrust.js';
import { bereiteGruppenSnapshotVor, getAltfallEntscheidung } from './exportSnapshot.js';
import { listeKommentare } from './kommentare.js';

// mergeBelegFuerJob (beim Aufsplitten, kontierung.js) fügt Belegseiten immer direkt hinter die Rechnungsseiten ein, vor jedem späteren
// Stempeln — mit der damals festgehaltenen Belegseitenzahl (kind.beleg_seitenzahl) liegen die Belegseiten also immer genau bei
// [basisSeitenzahl, basisSeitenzahl + belegSeitenzahl), egal wie viele Stempel-/Verlaufsseiten ein späterer Abschluss von Freigabe 2
// dahinter anhängt.
//
// Den Bereich stattdessen aus der aktuellen Seitenzahl des Kind-PDFs abzuleiten (wie es eine frühere Version tat), ist falsch: Bis ein
// Gruppen-Merge läuft, hat freigabe2.js jedes Kind schon einzeln gestempelt, die Seitenzahl-Differenz würde also die eigene, überflüssige
// Stempelseite jedes Kindes in das gemeinsame Archivdokument ziehen — genau das, was diese Funktion vermeiden soll.
// Kopiert die Belegseiten des Kindes ans Gruppendokument (siehe oben). Wirft, wenn die gespeicherte Belegseitenzahl nicht passt.
async function haengeBelegSeitenAn(gruppenDoc, kindBytes, basisSeitenzahl, belegSeitenzahl) {
  if (!belegSeitenzahl) return;
  const kindDoc = await PDFDocument.load(kindBytes);
  if (!Number.isInteger(belegSeitenzahl) || belegSeitenzahl < 0 || basisSeitenzahl + belegSeitenzahl > kindDoc.getPageCount()) {
    throw new Error('Die gespeicherte Belegseitenzahl passt nicht zum Teilbeleg.');
  }
  const belegIndices = kindDoc.getPageIndices().slice(basisSeitenzahl, basisSeitenzahl + belegSeitenzahl);
  const copiedPages = await gruppenDoc.copyPages(kindDoc, belegIndices);
  copiedPages.forEach((page) => gruppenDoc.addPage(page));
}

// Kommentare (Task Kommentare an Rechnungen) für die Stempelseite; unveränderlich, darum live gelesen.
function kommentareFuerStempel(db, jobId) {
  return listeKommentare(db, jobId).map((k) => ({ zeitpunkt: k.erstellt_am, verfasser: k.verfasser_name, text: k.text }));
}

// Stand aller Kommentare der Gruppe (Elternjob + Teile): ändert er sich während Stempeln/TSA,
// wird nicht festgeschrieben -- der Nachhol-Job stempelt dann mit dem neuen Kommentar neu.
// (Siehe Kommentar oben.)
function kommentarStandGruppe(db, jobIds) {
  return jobIds.map((id) => { const liste = listeKommentare(db, id); return `${id}:${liste.length}:${liste.at(-1)?.id ?? 0}`; }).join('|');
}

// Momentaufnahme des Gruppenstands (Vollständigkeit, Konten, Freigaben, Altfall-Entscheidung) – wird vor und nach der Arbeit verglichen.
function groupState(db, parentJobId) {
  const completeness = pruefeSplitGruppenVollstaendigkeit(db, parentJobId);
  return {
    parent: getJobById(db, parentJobId),
    ...completeness,
    details: completeness.kinder.map((kind) => ({
      konto: getKontoById(db, kind.konto_id),
      freigaben: listFreigabenByJob(db, kind.id).map((freigabe) => ({ ...freigabe, person: getPersonById(db, freigabe.person_id) })),
    })),
    altfallEntscheidung: getAltfallEntscheidung(db, parentJobId)?.id ?? null,
  };
}

// Führt eine vollständige Splitgruppe (alle Kinder abgeschlossen) zu einem gestempelten, zeitgestempelten PDF zusammen und hält es am
// Elternjob fest. Best-Effort und von Natur aus idempotent: wirkungslos, wenn die Gruppe (noch) nicht vollständig ist, durch ein
// abgelehntes Geschwister blockiert wird oder schon exportiert ist (gruppe_pdf_pfad schon gesetzt) — gefahrlos wiederholt aus mehreren
// Auslösern aufrufbar (Abschluss Freigabe 2, Löschung einer blockierenden Zeile, Nachhol-Cron-Job).
//
// Blockiert bewusst den ganzen Export bei einer konfigurierten, aber nicht erreichbaren TSA (anders als stampAndFinalize je Job in
// freigabe2.js, das bei TSA-Ausfall ohne Zeitstempel weitermacht): Der ganze Zweck dieses zusammengeführten Dokuments ist die Papierlos-
// Archivkopie für Paperless-ngx; sie ohne den Zeitstempel auszuliefern, für den sie gebaut wurde, würde diesen Zweck verfehlen. Wird
// später vom Cron-Job split-gruppen-nachholen (cronJobs.js) wiederholt, gerade weil gruppe_pdf_pfad bei einem Fehler ungesetzt bleibt.
// @returns {Promise<{status: 'exportiert'|'uebersprungen'|'blockiert'|'unvollstaendig'|'nachpruefung'|'fehler', ...}>}
export async function pruefeUndFinalisiereSplitGruppe(db, parentJobId, config = {}) {
  let parent = getJobById(db, parentJobId);
  if (!parent || parent.status !== 'aufgesplittet' || parent.gruppe_pdf_pfad) return { status: 'uebersprungen' };

  const { vollstaendig, blockiert, kinder } = pruefeSplitGruppenVollstaendigkeit(db, parentJobId);
  let zielPfad;
  try {
    const tsaUrl = getConfigValue(db, 'zeitstempel_tsa_url');
    // Vor Netzwerk-/Dateiarbeit festhalten, damit ein Fehlschlag gefolgt vom Abschalten der TSA die Pflicht nicht zurücknehmen kann.
    if (!parent.zeitstempel_erforderlich && (tsaUrl || kinder.some((kind) => kind.zeitstempel_erforderlich))) {
      db.prepare('UPDATE jobs SET zeitstempel_erforderlich = 1 WHERE id = ?').run(parent.id);
      parent = getJobById(db, parent.id);
    }
    if (blockiert) return { status: 'blockiert' };
    if (!vollstaendig) return { status: 'unvollstaendig' };
    if (parent.zeitstempel_erforderlich && !tsaUrl) throw new Error('Zeitstempel ist verpflichtend; TSA muss wieder konfiguriert werden.');
    const state = groupState(db, parentJobId);
    const vorbereitung = bereiteGruppenSnapshotVor(db, parent, kinder);
    // Ohne vollstaendig bestaetigte Zahlungs-/Freigabedaten entsteht kein Archivdokument; die
    // Gruppe erscheint unter Admin -> Altfaelle zur ausdruecklichen Entscheidung.
    if (vorbereitung.nachpruefung) return { status: 'nachpruefung', grund: vorbereitung.nachpruefung };
    const gruppenSnapshot = vorbereitung.snapshot;
    const basisBuffer = readFileSync(parent.pdf_pfad);
    const kindBuffers = kinder.map((kind) => {
      const bytes = readFileSync(kind.pdf_pfad);
      const expected = kind.zeitstempel_datei_hash || kind.final_datei_hash;
      if (expected && createHash('sha256').update(bytes).digest('hex') !== expected) {
        throw new Error('Teilbeleg stimmt nicht mit seinem Freigabe-Hash überein.');
      }
      return bytes;
    });
    const basisDoc = await PDFDocument.load(basisBuffer);
    const basisSeitenzahl = basisDoc.getPageCount();
    const gruppenDoc = await PDFDocument.load(basisBuffer);

    const kommentarStand = kommentarStandGruppe(db, [parent.id, ...kinder.map((kind) => kind.id)]);
    const positionen = [];
    const verlauf = [];
    // Stempelseite und Export entstehen aus demselben eingefrorenen Gruppen-Snapshot: Konto, Betrag,
    // Typ, Freigaben und Verlauf je Position stammen aus dem Freigabe-Snapshot des Teilbelegs.
    const positionsIds = gruppenSnapshot.positionen.map((position) => position.job_id);
    if (positionsIds.length !== kinder.length || kinder.some((kind) => !positionsIds.includes(kind.id))) {
      throw new Error('Der Gruppen-Snapshot deckt nicht genau die aktuellen Teilbelege ab.');
    }
    for (const position of gruppenSnapshot.positionen) {
      const index = kinder.findIndex((kind) => kind.id === position.job_id);
      positionen.push({
        kontoNummer: position.konto_kontonummer,
        kontoBezeichnung: position.konto_bezeichnung,
        betrag: position.betrag,
        typ: position.typ,
        position: position.position,
        kkHinweis: position.kkHinweis,
        freigeber1: position.freigeber1,
        freigeber2: position.freigeber2,
        jobId: position.job_id,
        kommentare: kommentareFuerStempel(db, position.job_id),
      });
      const praefix = `Konto ${position.konto_kontonummer}${position.position ? ` (Pos. ${position.position})` : ''}`;
      for (const eintrag of position.verlauf) {
        verlauf.push({ ...eintrag, rolleLabel: `${praefix} — ${eintrag.rolleLabel}` });
      }
      await haengeBelegSeitenAn(gruppenDoc, kindBuffers[index], basisSeitenzahl, kinder[index].beleg_seitenzahl);
    }
    verlauf.sort((a, b) => (a.zeitpunkt < b.zeitpunkt ? -1 : a.zeitpunkt > b.zeitpunkt ? 1 : 0));

    const gruppenPdfMitBelegen = Buffer.from(await gruppenDoc.save());
    let gestempelt = await stampGruppenDokument(gruppenPdfMitBelegen, { jobId: parent.id, positionen, verlauf, kommentare: kommentareFuerStempel(db, parent.id), ...(config.testmodus ? { testmodus: true } : {}) });

    let zeitstempelGesetztAm = null;
    let zeitstempelDateiHash = null;
    let tsaNachweis = null;
    if (tsaUrl) {
      ({ stamped: gestempelt, nachweis: tsaNachweis } = await setZeitstempelMitNachweis(gestempelt, {
        ...tsaTrustOptions(config),
        url: tsaUrl,
        user: getConfigValue(db, 'zeitstempel_tsa_user') || undefined,
        passwort: getConfigValue(db, 'zeitstempel_tsa_passwort') || undefined,
      }));
      zeitstempelGesetztAm = new Date().toISOString();
      zeitstempelDateiHash = createHash('sha256').update(gestempelt).digest('hex');
    }

    zielPfad = writeFinalDocument(parent.pdf_pfad, gestempelt);
    db.exec('BEGIN IMMEDIATE');
    try {
      if (getJobById(db, parent.id)?.gruppe_pdf_pfad) {
        db.exec('ROLLBACK');
        unlinkSync(zielPfad);
        zielPfad = undefined;
        return { status: 'uebersprungen' };
      }
      if (JSON.stringify(groupState(db, parent.id)) !== JSON.stringify(state) ||
          getConfigValue(db, 'zeitstempel_tsa_url') !== tsaUrl ||
          !readFileSync(parent.pdf_pfad).equals(basisBuffer) ||
          kommentarStandGruppe(db, [parent.id, ...kinder.map((kind) => kind.id)]) !== kommentarStand ||
          kinder.some((kind, index) => !readFileSync(kind.pdf_pfad).equals(kindBuffers[index]))) {
        throw new Error('Gruppenstand oder Quelldateien wurden während der Finalisierung geändert.');
      }
      if (db.prepare('SELECT 1 FROM export_nachweise WHERE job_id = ?').get(parent.id)) throw new Error('Archivexport wurde bereits festgeschrieben.');
      const geschrieben = markGruppeExportiert(db, parent.id, {
        pdfPfad: zielPfad, zeitstempelGesetztAm, zeitstempelDateiHash,
        finalDateiHash: createHash('sha256').update(gestempelt).digest('hex'),
        gruppeFreigabeSnapshot: JSON.stringify(gruppenSnapshot),
      });
      if (!geschrieben) throw new Error('Gruppe wurde inzwischen finalisiert.');
      if (zeitstempelDateiHash) speichereTsaNachweis(db, { jobId: parent.id, bezug: 'gruppe', dokumentSha256: zeitstempelDateiHash, nachweis: tsaNachweis });
      db.exec('COMMIT');
    } catch (err) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw err;
    }
    const pdfPfad = zielPfad;
    zielPfad = undefined;
    return { status: 'exportiert', pdfPfad };
  } catch (err) {
    if (zielPfad) {
      try { unlinkSync(zielPfad); } catch { /* Nie die Datei eines anderen Versuchs entfernen. */ }
    }
    console.error(`Splitgruppen-Export für Elternjob ${parentJobId} fehlgeschlagen, wird nachgeholt:`, err.message);
    return { status: 'fehler', error: err.message };
  }
}
