// Reine PDF-Arbeit des Splitgruppen-Exports (B2, Etappe 5): Basis-PDF + Belegseiten der Teile zusammenführen und den
// Gruppenstempel anhängen. Läuft als Aufgabe `gruppenDokumentErstellen` im PDF-Worker (workers/pdfAufgaben.js); die
// Datenbankarbeit (Snapshot, Prüfungen, Festschreiben) bleibt in services/splitGruppenExport.js im Hauptthread.
// Nur pdf-lib, keine Datenbank – Argumente und Ergebnis sind per structured clone übertragbar.

import { PDFDocument } from 'pdf-lib';
import { stampGruppenDokument } from './pdfStamp.js';

// Das Beleg-Anhängen (Aufgabe belegAnhaengen, beim Aufsplitten und in der Kontierung) fügt Belegseiten immer direkt hinter die Rechnungsseiten ein, vor jedem späteren
// Stempeln — mit der damals festgehaltenen Belegseitenzahl (kind.beleg_seitenzahl) liegen die Belegseiten also immer genau bei
// [basisSeitenzahl, basisSeitenzahl + belegSeitenzahl), egal wie viele Stempel-/Verlaufsseiten ein späterer Abschluss von Freigabe 2
// dahinter anhängt.
//
// Den Bereich stattdessen aus der aktuellen Seitenzahl des Kind-PDFs abzuleiten (wie es eine frühere Version tat), ist falsch: Bis ein
// Gruppen-Merge läuft, hat freigabe2.js jedes Kind schon einzeln gestempelt, die Seitenzahl-Differenz würde also die eigene, überflüssige
// Stempelseite jedes Kindes in das gemeinsame Archivdokument ziehen — genau das, was der Export vermeiden soll.
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

/**
 * Erstellt das gestempelte Gruppendokument (noch ohne RFC3161-Zeitstempel).
 * @param {Buffer} basisBuffer PDF des Elternjobs (die ursprüngliche Rechnung)
 * @param {{pdf: Buffer, belegSeitenzahl: number|null}[]} teile in der Reihenfolge der Positionen des Gruppen-Snapshots
 * @param {object} stempelDaten Daten für stampGruppenDokument (jobId, positionen, verlauf, kommentare, testmodus)
 * @returns {Promise<Buffer>}
 */
export async function erstelleGruppenDokument(basisBuffer, teile, stempelDaten) {
  const basisDoc = await PDFDocument.load(basisBuffer);
  const basisSeitenzahl = basisDoc.getPageCount();
  const gruppenDoc = await PDFDocument.load(basisBuffer);
  for (const teil of teile) {
    await haengeBelegSeitenAn(gruppenDoc, teil.pdf, basisSeitenzahl, teil.belegSeitenzahl);
  }
  const gruppenPdfMitBelegen = Buffer.from(await gruppenDoc.save());
  return stampGruppenDokument(gruppenPdfMitBelegen, stempelDaten);
}
