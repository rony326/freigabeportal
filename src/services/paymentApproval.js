// Zahlungsdaten und Zahlungsbestätigung: welche Zahlung ein freigegebener Beleg auslöst (Spesen, QR-Rechnung, ohne Daten, keine) und wie
// die Angaben geprüft werden. Fachlich: docs/export-und-zahlungsintegritaet.md und docs/qr-bill-und-betrugserkennung.md. n8n zahlt nur,
// wenn die Zahlung ausdrücklich bestätigt wurde (services/exportSnapshot.js, `freigegeben`).

import { createHash } from 'node:crypto';
import { normalizeIban, isValidIban, ibanChecksumValid } from './ibanUtils.js';
import { listKreditorIbansByKreditor } from '../db/kreditorIbanRepo.js';

const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

// Bereinigter Name (getrimmt, höchstens 200 Zeichen, keine Steuerzeichen) oder null.
function cleanName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  return name && name.length <= 200 && !CONTROL_CHARS.test(name) ? name : null;
}

// Prüft IBAN (CH, Prüfziffer) und Kontoinhaber einer Spesenauszahlung. @returns {{iban: string, kontoinhaber: string}|null}
export function validateSpesenPayment(iban, owner) {
  const normalized = typeof iban === 'string' ? normalizeIban(iban) : '';
  const kontoinhaber = cleanName(owner);
  if (!isValidIban(normalized) || !kontoinhaber || !ibanChecksumValid(normalized)) return null;
  return { iban: normalized, kontoinhaber };
}

// Zahlungsdaten einer Swiss-QR-Bill, so wie sie beim Eingang gescannt wurden. Unvollstaendige
// oder ungueltige Daten liefern null -- sie werden nie als Zahlungsauftrag exportiert.
export function validateQrPayment(job) {
  const iban = typeof job.qr_iban === 'string' ? normalizeIban(job.qr_iban) : '';
  const empfaenger = cleanName(job.qr_creditor_name);
  if (!isValidIban(iban) || !ibanChecksumValid(iban) || !empfaenger) return null;
  const referenz = typeof job.qr_referenz === 'string' && job.qr_referenz.trim() ? job.qr_referenz.trim() : null;
  if (referenz && (referenz.length > 35 || CONTROL_CHARS.test(referenz))) return null;
  return { iban, empfaenger, referenz, betrag: job.qr_betrag || null, waehrung: job.qr_waehrung || null };
}

// Welche Zahlung ein freigegebener Beleg ausloest. Bei Splitgruppen gilt die Zahlung der ganzen
// Rechnung (Elternjob); jedes Kind bestaetigt dieselben Daten.
//   spesen             -- Rueckerstattung an die einreichende Person (IBAN aus ChurchTools)
//   qr_rechnung        -- Zahlung an den Empfaenger der Swiss-QR-Bill
//   ohne_zahlungsdaten -- Rechnung ohne maschinenlesbare Zahlungsdaten: Zahlung wird manuell erfasst
//   keine_zahlung      -- Gutschrift: es fliesst kein Geld ab
export function bestimmeZahlungsart(job, parent = null) {
  if (job.quelle === 'spesen') return 'spesen';
  const basis = parent || job;
  if (basis.typ === 'gutschrift') return 'keine_zahlung';
  return basis.qr_iban ? 'qr_rechnung' : 'ohne_zahlungsdaten';
}

// Spesen und QR-Rechnungen (und alles mit Hinweisen) müssen bei Freigabe 2 ausdrücklich bestätigt werden.
export function zahlungBestaetigungspflichtig(zahlung) {
  return zahlung.art === 'spesen' || zahlung.art === 'qr_rechnung' || zahlung.hinweise.length > 0;
}

const QR_FELDER = ['qr_iban', 'qr_referenz', 'qr_betrag', 'qr_waehrung', 'qr_creditor_name'];

// true, wenn beide Beträge vorliegen und um mindestens einen Rappen abweichen.
function betragWeichtAb(a, b) {
  if (a == null || a === '' || b == null || b === '') return false;
  const x = Number(a);
  const y = Number(b);
  return Number.isFinite(x) && Number.isFinite(y) && Math.abs(x - y) >= 0.005;
}

// Zahlungsstand einer Nicht-Spesen-Freigabe aus lokal gespeicherten Eingangsdaten (QR-Scan) und
// dem aktuellen Abgleich mit den hinterlegten Lieferanten-IBANs. Der Abgleich ist eine Pruefung,
// kein Datenlieferant: er wird im Snapshot eingefroren, die IBAN selbst stammt immer aus dem Beleg.
/**
 * @returns {{art, daten, abgleich, hinweise}|{fehler: string}} Zahlungsstand; `abgleich` ∈ kein_lieferant | keine_iban_hinterlegt |
 *   uebereinstimmung | abweichung, `hinweise` u. a. 'iban_abweichung', 'betrag_abweichung', 'qr_ungueltig'. `fehler`, wenn ein Teilbeleg
 *   andere QR-Daten als die Gesamtrechnung trägt.
 */
export function ermittleRechnungsZahlung(db, job, parent = null) {
  if (parent && QR_FELDER.some((feld) => (parent[feld] ?? null) !== (job[feld] ?? null))) {
    return { fehler: 'Die QR-Zahlungsdaten dieses Teilbelegs weichen von der Gesamtrechnung ab. Bitte ablehnen und die Rechnung prüfen lassen.' };
  }
  const art = bestimmeZahlungsart(job, parent);
  if (art !== 'qr_rechnung') return { art, daten: null, abgleich: null, hinweise: [] };
  const daten = validateQrPayment(job);
  if (!daten) return { art: 'ohne_zahlungsdaten', daten: null, abgleich: null, hinweise: ['qr_ungueltig'] };
  const hinweise = [];
  let abgleich = 'kein_lieferant';
  if (job.kreditor_id) {
    const hinterlegte = listKreditorIbansByKreditor(db, job.kreditor_id);
    abgleich = hinterlegte.length === 0 ? 'keine_iban_hinterlegt' : hinterlegte.some((row) => row.iban === daten.iban) ? 'uebereinstimmung' : 'abweichung';
  }
  if (abgleich === 'abweichung') hinweise.push('iban_abweichung');
  if (betragWeichtAb(daten.betrag, (parent || job).betrag)) hinweise.push('betrag_abweichung');
  return { art, daten, abgleich, hinweise };
}

// Anzeigetexte der Hinweise (für Freigabe 2 und die Altfall-Ansicht).
export const ZAHLUNGSHINWEIS_TEXT = {
  qr_ungueltig: 'Die QR-Zahlungsdaten sind unvollständig oder ungültig. Es werden keine Zahlungsdaten exportiert; die Zahlung muss manuell erfasst werden.',
  iban_abweichung: 'Die QR-IBAN ist für diesen Lieferanten nicht hinterlegt.',
  betrag_abweichung: 'Der QR-Betrag weicht vom erfassten Rechnungsbetrag ab.',
};

// Fingerabdruck gegen veraltete Formulare, kein Autorisierungs-Token; die Berechtigung prüft die Route.
export function paymentReviewFingerprint(job, konto, payment, personId) {
  return createHash('sha256').update(JSON.stringify({ job, konto, payment, personId })).digest('hex');
}
