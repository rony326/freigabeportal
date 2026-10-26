import { getConfigValue } from '../db/adminConfigRepo.js';

// Persönliche Bündelung der Benachrichtigungen
// (docs/superpowers/specs/2026-10-25-persoenliche-benachrichtigungen-design.md).
//
// personen.benachrichtigung: 'sofort' | 'taeglich' | 'woechentlich' | NULL (= Admin-Standard
// mail_standard_benachrichtigung). Die Wahl entscheidet beim Einreihen, ob eine Mail sofort geht
// oder 'geplant' auf den Digest wartet (services/notify.js), und beim Digest-Lauf, ob die
// geplanten Zeilen eines Empfängers heute fällig sind (services/cronJobs.js runMailDigestJob).
// Beim Digest zählt die AKTUELLE Wahl -- wer wechselt, verliert nichts.

export const BENACHRICHTIGUNG_WERTE = ['sofort', 'taeglich', 'woechentlich'];

const ZEITZONE = 'Europe/Zurich';
const WOCHENTAG_FORMAT = new Intl.DateTimeFormat('en-US', { timeZone: ZEITZONE, weekday: 'short' });
const WOCHENTAG_NUMMER = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

function istGueltig(wert) {
  return BENACHRICHTIGUNG_WERTE.includes(wert);
}

export function standardBenachrichtigung(db) {
  const wert = getConfigValue(db, 'mail_standard_benachrichtigung');
  return istGueltig(wert) ? wert : 'sofort';
}

// Zuordnung über lower(email). Teilen sich mehrere Personen die Adresse, gilt die kürzeste
// Bündelung (sofort < täglich < wöchentlich), damit niemand Mails später bekommt als gewählt.
// Aktive Personen gehen vor; nur wenn keine aktive passt, zählen deaktivierte. Adresse ohne
// Person oder Person ohne (gültige) Wahl → Standard.
export function benachrichtigungFuer(db, email) {
  const standard = standardBenachrichtigung(db);
  const adresse = String(email ?? '').trim();
  if (!adresse) return standard;
  const personen = db.prepare('SELECT aktiv, benachrichtigung FROM personen WHERE LOWER(email) = LOWER(?)').all(adresse);
  const aktive = personen.filter((p) => p.aktiv === 1);
  const basis = aktive.length ? aktive : personen;
  if (!basis.length) return standard;
  let kuerzeste = null;
  for (const p of basis) {
    const wert = istGueltig(p.benachrichtigung) ? p.benachrichtigung : standard;
    if (kuerzeste === null || BENACHRICHTIGUNG_WERTE.indexOf(wert) < BENACHRICHTIGUNG_WERTE.indexOf(kuerzeste)) kuerzeste = wert;
  }
  return kuerzeste;
}

// Wochentag (1 = Montag … 7 = Sonntag) nach Zürcher Kalenderdatum.
export function zuercherWochentag(jetzt) {
  return WOCHENTAG_NUMMER[WOCHENTAG_FORMAT.format(new Date(jetzt))];
}

export function istDigestFaellig(wert, jetzt, wochentag) {
  if (wert !== 'woechentlich') return true;
  return zuercherWochentag(jetzt) === Number(wochentag);
}

export function digestWochentag(db) {
  const n = Number(getConfigValue(db, 'mail_digest_wochentag'));
  return Number.isInteger(n) && n >= 1 && n <= 7 ? n : 1;
}

export function setzeBenachrichtigung(db, personId, wert) {
  if (wert !== null && !istGueltig(wert)) {
    throw new Error(`Ungültige Benachrichtigungs-Einstellung: ${wert}`);
  }
  db.prepare('UPDATE personen SET benachrichtigung = ? WHERE churchtools_person_id = ?').run(wert, personId);
}
