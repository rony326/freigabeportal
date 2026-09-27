import { mkdirSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { buildBelegPdf } from './belegAnhaengen.js';
import { renderFirstPageThumbnail } from './thumbnail.js';

// Betrag darf beim Kreditkarten-Beleg negativ sein (Rückerstattung) -- im Gegensatz zum
// BETRAG_PATTERN der Kontierung.
export const KK_BETRAG_PATTERN = /^-?\d+([.,]\d{1,2})?$/;
export const KK_DATUM_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function normalisiereBetrag(betrag) {
  return Number(String(betrag).replace(',', '.')).toFixed(2);
}

// Speichert einen hochgeladenen Beleg immer als PDF (Bilder werden wie bei Spesen in eine
// A4-Seite umgewandelt) plus Thumbnail (best effort) in jobsDir.
export async function speichereKkBelegDatei(config, buffer, mimetype) {
  mkdirSync(config.jobsDir, { recursive: true });
  const pdfBuffer = await buildBelegPdf(buffer, mimetype);
  const pdfPfad = join(config.jobsDir, `kkbeleg-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);
  writeFileSync(pdfPfad, pdfBuffer);
  let thumbnailPfad = null;
  try {
    thumbnailPfad = pdfPfad.replace(/\.pdf$/, '.png');
    writeFileSync(thumbnailPfad, renderFirstPageThumbnail(pdfBuffer));
  } catch (err) {
    console.error(`Thumbnail-Rendering für Kreditkarten-Beleg fehlgeschlagen (${pdfPfad}):`, err.message);
    thumbnailPfad = null;
  }
  return { pdfPfad, thumbnailPfad };
}

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
