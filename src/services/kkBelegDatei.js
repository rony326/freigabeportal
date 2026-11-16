// Dateien von Kreditkartenbelegen: Upload immer als PDF (Bilder → A4-Seite) mit Thumbnail ablegen und Dateien still entfernen (docs/kreditkarten-belege.md).

import { mkdirSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { pdfArbeit } from './pdfArbeit.js';

// Betrag darf beim Kreditkarten-Beleg negativ sein (Rückerstattung) -- im Gegensatz zum
// BETRAG_PATTERN der Kontierung.
export const KK_BETRAG_PATTERN = /^-?\d+([.,]\d{1,2})?$/;
export const KK_DATUM_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// Betrag mit Punkt und zwei Nachkommastellen ("12,5" → "12.50").
export function normalisiereBetrag(betrag) {
  return Number(String(betrag).replace(',', '.')).toFixed(2);
}

// Speichert einen hochgeladenen Beleg immer als PDF (Bilder werden wie bei Spesen in eine
// A4-Seite umgewandelt) plus Thumbnail (best effort) in jobsDir.
// B2: PDF und Vorschaubild entstehen im PDF-Worker (Aufgabe belegDateiErstellen), bevor eine Datei geschrieben wird.
// Scheitert der Worker (PdfWorkerFehler: Überlastung, Zeitlimit, Absturz), wirft die Funktion ohne angelegte Datei;
// der Aufrufer antwortet dann mit 503 (Formular) bzw. kkBelegEingang mit 503 an n8n.
// @param {{spur?: 'interaktiv'|'hintergrund'}} [optionen] Spur im Worker-Pool; Standard interaktiv (eine Person wartet)
export async function speichereKkBelegDatei(config, buffer, mimetype, { spur = 'interaktiv' } = {}) {
  const { pdf, vorschaubild, vorschaubildFehler } = await pdfArbeit().ausfuehren('belegDateiErstellen', [buffer, mimetype], { spur });
  mkdirSync(config.jobsDir, { recursive: true });
  const pdfPfad = join(config.jobsDir, `kkbeleg-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);
  writeFileSync(pdfPfad, pdf);
  let thumbnailPfad = null;
  try {
    if (!vorschaubild) throw new Error(vorschaubildFehler ?? 'kein Vorschaubild');
    thumbnailPfad = pdfPfad.replace(/\.pdf$/, '.png');
    writeFileSync(thumbnailPfad, vorschaubild);
  } catch (err) {
    console.error(`Thumbnail-Rendering für Kreditkarten-Beleg fehlgeschlagen (${pdfPfad}):`, err.message);
    thumbnailPfad = null;
  }
  return { pdfPfad, thumbnailPfad };
}

// Löscht Dateien; fehlende Pfade und Fehler werden übergangen bzw. nur protokolliert (z. B. zum Aufräumen nach einem Abbruch).
export function loescheDateienStill(...pfade) {
  for (const pfad of pfade) {
    if (!pfad) continue;
    try {
      if (existsSync(pfad)) unlinkSync(pfad);
    } catch (err) {
      console.error(`Löschen von ${pfad} fehlgeschlagen:`, err.message);
    }
  }
}
