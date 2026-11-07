// Budget-Import aus CSV oder Excel (.xlsx): Datei lesen, Spalten zuordnen, gegen Konten prüfen.
// Speichern macht die Route erst nach Bestätigung der Vorschau.

import { readSheet } from 'read-excel-file/node';
import { parseBetrag } from './auswertung.js';

export const MAX_ZEILEN = 2000;

// Trennzeichen aus der ersten Zeile (ausserhalb von Anführungszeichen): ; oder ,
function trennzeichen(text) {
  let semikolon = 0;
  let komma = 0;
  let inQuote = false;
  for (const zeichen of text) {
    if (zeichen === '"') inQuote = !inQuote;
    else if (!inQuote && zeichen === ';') semikolon += 1;
    else if (!inQuote && zeichen === ',') komma += 1;
    else if (!inQuote && zeichen === '\n') break;
  }
  return komma > semikolon ? ',' : ';';
}

function parseCsv(text) {
  const trenner = trennzeichen(text);
  const zeilen = [];
  let zeile = [];
  let feld = '';
  let inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const zeichen = text[i];
    if (inQuote) {
      if (zeichen === '"' && text[i + 1] === '"') { feld += '"'; i += 1; }
      else if (zeichen === '"') inQuote = false;
      else feld += zeichen;
    } else if (zeichen === '"') {
      inQuote = true;
    } else if (zeichen === trenner) {
      zeile.push(feld); feld = '';
    } else if (zeichen === '\n' || zeichen === '\r') {
      if (zeichen === '\r' && text[i + 1] === '\n') i += 1;
      zeile.push(feld); zeilen.push(zeile); zeile = []; feld = '';
    } else {
      feld += zeichen;
    }
  }
  if (feld !== '' || zeile.length) { zeile.push(feld); zeilen.push(zeile); }
  return zeilen;
}

function ohneLeereEndzeilen(zeilen) {
  const kopie = zeilen.map((z) => z.map((w) => (w === null || w === undefined ? '' : String(w).trim())));
  while (kopie.length && kopie[kopie.length - 1].every((w) => w === '')) kopie.pop();
  return kopie;
}

export async function leseTabelle(buffer, dateiname) {
  const endung = String(dateiname || '').toLowerCase().split('.').pop();
  let zeilen;
  if (endung === 'csv') {
    zeilen = parseCsv(buffer.toString('utf8').replace(/^﻿/, ''));
  } else if (endung === 'xlsx') {
    try {
      zeilen = await readSheet(buffer);
    } catch {
      throw new Error('Die Excel-Datei konnte nicht gelesen werden. Bitte als .xlsx oder CSV speichern und erneut hochladen.');
    }
  } else {
    throw new Error('Bitte eine CSV- oder Excel-Datei (.xlsx) hochladen.');
  }
  const ergebnis = ohneLeereEndzeilen(zeilen);
  if (ergebnis.length > MAX_ZEILEN) throw new Error(`Die Datei hat mehr als ${MAX_ZEILEN} Zeilen.`);
  return ergebnis;
}

// Kopfzeile, wenn die Betragszelle der ersten Zeile keine Zahl ist.
export function erkenneKopfzeile(zeilen, spalteBetrag) {
  if (!zeilen.length) return false;
  return parseBetrag(zeilen[0][spalteBetrag] ?? '') === null;
}

// konten: aktive Konten [{ id, kontonummer }]; bisher: Map kontoId → Budget im Zieljahr.
export function ordneZu(zeilen, { spalteKonto, spalteBetrag, hatKopfzeile }, konten, bisher = new Map()) {
  const nachNummer = new Map();
  for (const k of konten) if (!nachNummer.has(k.kontonummer)) nachNummer.set(k.kontonummer, k);
  const gueltig = [];
  const fehler = [];
  const gesehen = new Set();
  zeilen.forEach((zeile, index) => {
    if (hatKopfzeile && index === 0) return;
    const nummer = index + 1;
    const kontonummer = String(zeile[spalteKonto] ?? '').trim();
    const rohBetrag = String(zeile[spalteBetrag] ?? '').trim();
    if (!kontonummer && !rohBetrag) return fehler.push({ zeile: nummer, grund: 'Leere Zeile' });
    const konto = nachNummer.get(kontonummer);
    if (!konto) return fehler.push({ zeile: nummer, grund: `Kontonummer «${kontonummer || '—'}» gibt es nicht (oder das Konto ist inaktiv)` });
    const betrag = parseBetrag(rohBetrag);
    if (betrag === null) return fehler.push({ zeile: nummer, grund: `Betrag «${rohBetrag || '—'}» ist keine gültige Zahl` });
    if (gesehen.has(konto.id)) return fehler.push({ zeile: nummer, grund: `Konto ${kontonummer} kommt mehrfach vor; nur die erste Zeile zählt` });
    gesehen.add(konto.id);
    gueltig.push({ kontoId: konto.id, kontonummer, betrag, bisher: bisher.has(konto.id) ? bisher.get(konto.id) : null });
  });
  return { gueltig, fehler };
}
