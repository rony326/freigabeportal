// (Fachliche Beschreibung der Prüfungen: docs/qr-bill-und-betrugserkennung.md.)

// Auffälligkeiten bei der Kontierung (Spec 2026-11-10, B4). Nur Lesezugriffe: Dieser Service
// ermittelt Befunde, schreibt nichts und verschickt keine Mails — das Verdrahten (Popup, Protokoll,
// Benachrichtigung) machen die Routen.
import crypto from 'node:crypto';
import { normalizeIban, ibanKurz } from './ibanUtils.js';
import { brauchtIban, getKreditorById, ZAHLUNGSART_LABEL } from '../db/kreditorenRepo.js';
import { listKreditorIbansByKreditor, findKreditorIbanByIban } from '../db/kreditorIbanRepo.js';
import { DEFAULTS, getConfigValue } from '../db/adminConfigRepo.js';

/** @typedef {{ code: string, schwere: 'rot'|'gelb', titel: string, text: string }} Befund */

// Sortierreihenfolge der Befund-Codes innerhalb derselben Schwere im Prüf-Popup.
const CODE_REIHENFOLGE = [
  'iban_anderer_kreditor', 'iban_fremd', 'iban_manuell_fremd', 'zahlungsart_ohne_iban',
  'name', 'betrag_qr', 'betrag_hoch', 'neuer_kreditor', 'gleicher_betrag',
];

// „Frühere kontierte Rechnungen“: alles ab Kontierung/Freigabe 1 (freigabe2, abgeschlossen, abgeholt,
// archiviert und die Altwerte kontiert/freigabe1). kenntnisnahme gibt es nur für Rapporte und fällt
// über den Typ-Filter raus. Siehe docs/rechnungs-workflow.md, Status-Modell.
export const FRUEHERE_RECHNUNGEN_AUSGESCHLOSSENE_STATUS = ['abgelehnt', 'geloescht', 'unzugewiesen', 'zugewiesen', 'aufgesplittet'];

const TAG_MS = 24 * 60 * 60 * 1000;
const DATUM = new Intl.DateTimeFormat('de-CH', { timeZone: 'Europe/Zurich', day: '2-digit', month: '2-digit', year: 'numeric' });

const RECHTSFORMEN = /(^|[^a-z0-9])(e\.v\.|ag|gmbh|sa|sarl|klg|kg|ltd|llc|inc|ev|co|cie|genossenschaft|stiftung|verein)(?=[^a-z0-9]|$)/g;

// Vergleichsform eines Firmennamens: Kleinschreibung, ohne Akzente, Rechtsformen (AG, GmbH …) und Sonderzeichen.
export function normalisiereFirmenname(name) {
  return String(name ?? '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss')
    .replace(RECHTSFORMEN, '$1')
    .replace(/[^a-z0-9]/g, '')
    // Umlaut-Umschreibung (Mueller) auf den Grundvokal zurückführen, wie die NFD-Variante (Müller → muller).
    .replace(/([aou])e/g, '$1');
}

// Passt, wenn ein normalisierter Name den anderen enthält. Bewusst ohne Tippfehler-Toleranz:
// „Muster Druk“ statt „Muster Druck“ soll als Abweichung angezeigt werden (Spec B4).
export function namenPassen(a, b) {
  const na = normalisiereFirmenname(a);
  const nb = normalisiereFirmenname(b);
  if (!na || !nb) return false;
  return na.includes(nb) || nb.includes(na);
}

// true, wenn bei einer Rechnung ohne QR-IBAN für einen IBAN-pflichtigen Lieferanten die Endung von Hand geprüft werden muss.
export function brauchtManuelleIbanPruefung(job, kreditor, typ) {
  return !job.qr_iban && typ === 'rechnung' && brauchtIban(kreditor.zahlungsart);
}

// Passen die letzten 4 Zeichen zu einer hinterlegten IBAN des Lieferanten?
export function ibanEndungPasst(db, kreditorId, endung) {
  const normalisiert = normalizeIban(typeof endung === 'string' ? endung.trim() : '');
  if (normalisiert.length !== 4) return false;
  return listKreditorIbansByKreditor(db, kreditorId).some((row) => normalizeIban(row.iban).slice(-4) === normalisiert);
}

// Prüfsumme über Code und Text der Befunde – bindet die Bestätigung im Popup an genau diese Befunde.
export function befundeHash(befunde) {
  const daten = JSON.stringify(befunde.map(({ code, text }) => ({ code, text })));
  return crypto.createHash('sha256').update(daten).digest('hex');
}

// Betrag in Rappen; Komma, Apostroph und Leerzeichen erlaubt. Unlesbar → null.
function rappen(wert) {
  if (wert === null || wert === undefined) return null;
  const text = String(wert).trim().replace(/['’\s]/g, '').replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(text)) return null;
  return Math.round(Number(text) * 100);
}

function formatBetrag(betragRappen, waehrung) {
  const betrag = Math.abs(Math.round(betragRappen));
  const franken = String(Math.floor(betrag / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, "'");
  const rp = String(betrag % 100).padStart(2, '0');
  return `${waehrung} ${betragRappen < 0 ? '-' : ''}${franken}.${rp}`;
}

function schwelle(db, key) {
  const roh = getConfigValue(db, key);
  const wert = Number(roh);
  return roh !== null && roh !== '' && Number.isFinite(wert) && wert >= 0 ? wert : Number(DEFAULTS[key]);
}

// Frühere kontierte Rechnungen desselben Lieferanten (Betrag in Rappen, Zeitpunkt der Freigabe 1) als Vergleichsbasis.
function fruehereRechnungen(db, kreditorId, jobId) {
  const platzhalter = FRUEHERE_RECHNUNGEN_AUSGESCHLOSSENE_STATUS.map(() => '?').join(', ');
  const rows = db.prepare(`
    SELECT j.id, j.betrag, j.rechnungsnummer, j.eingang_am,
      (SELECT MAX(f.zeitpunkt) FROM freigaben f WHERE f.job_id = j.id AND f.rolle = 'freigeber1') AS freigabe1_am
    FROM jobs j
    WHERE j.kreditor_id = ? AND j.id != ? AND (j.typ IS NULL OR j.typ = 'rechnung')
      AND j.status NOT IN (${platzhalter}) AND j.betrag IS NOT NULL
  `).all(kreditorId, jobId ?? -1, ...FRUEHERE_RECHNUNGEN_AUSGESCHLOSSENE_STATUS);
  return rows
    .map((row) => ({
      id: row.id,
      rappen: rappen(row.betrag),
      rechnungsnummer: row.rechnungsnummer,
      // Freigabe 1 (rolle 'freigeber1', auch bei Stellvertretung/Eskalation/Aufsplitten). Altfälle
      // ohne Freigabe-Zeile fallen auf den Eingang zurück.
      zeitpunkt: Date.parse(row.freigabe1_am ?? row.eingang_am),
    }))
    .filter((r) => r.rappen !== null);
}

// true, wenn beide Rechnungsnummern gesetzt und gleich sind.
function gleicheNummer(a, b) {
  const na = (a ?? '').trim();
  const nb = (b ?? '').trim();
  return na !== '' && na === nb;
}

/**
 * IBAN-Befund (iban_anderer_kreditor bzw. iban_fremd), wenn die QR-IBAN nicht zu den hinterlegten
 * IBANs des Lieferanten gehört; sonst null. Prüft die Zahlungsart bewusst nicht — das entscheidet der
 * Aufrufer (ermittleBefunde nur bei IBAN-Pflicht, der Kreditkarten-Abgleich immer).
 * @returns {Befund|null}
 */
export function ibanBefund(db, kreditor, qrIbanRoh) {
  const qrIban = normalizeIban(qrIbanRoh);
  const eigene = listKreditorIbansByKreditor(db, kreditor.id).map((row) => normalizeIban(row.iban));
  if (eigene.includes(qrIban)) return null;
  const treffer = findKreditorIbanByIban(db, qrIban);
  const anderer = treffer && treffer.kreditor_id !== kreditor.id ? getKreditorById(db, treffer.kreditor_id) : null;
  if (anderer) {
    return { code: 'iban_anderer_kreditor', schwere: 'rot', titel: 'IBAN gehört einem anderen Lieferanten',
      text: `Die IBAN auf der Rechnung (${ibanKurz(qrIban)}) ist bei «${anderer.name}» hinterlegt, nicht bei «${kreditor.name}».` };
  }
  return { code: 'iban_fremd', schwere: 'rot', titel: 'IBAN nicht hinterlegt',
    text: `Die IBAN auf der Rechnung (${ibanKurz(qrIban)}) stimmt mit keiner hinterlegten IBAN von «${kreditor.name}» überein.` };
}

/**
 * @returns {Befund[]} sortiert: rot vor gelb, dann CODE_REIHENFOLGE.
 * `rechnungsnummer` (optional) ist die im Formular eingegebene Nummer; ohne Angabe gilt die des Jobs.
 */
export function ermittleBefunde(db, { job, kreditor, betrag, typ, ibanEndung = null, rechnungsnummer = job.rechnungsnummer }) {
  const befunde = [];
  const name = kreditor.name;
  const waehrung = job.qr_waehrung || 'CHF';
  const fmt = (r) => formatBetrag(r, waehrung);
  const qrIban = job.qr_iban ? normalizeIban(job.qr_iban) : null;

  if (qrIban && brauchtIban(kreditor.zahlungsart)) {
    const befund = ibanBefund(db, kreditor, qrIban);
    if (befund) befunde.push(befund);
  }
  if (qrIban && !brauchtIban(kreditor.zahlungsart)) {
    const label = ZAHLUNGSART_LABEL[kreditor.zahlungsart] ?? kreditor.zahlungsart;
    befunde.push({ code: 'zahlungsart_ohne_iban', schwere: 'gelb', titel: `Lieferant wird sonst per ${label} bezahlt`,
      text: `Diese Rechnung hat einen Einzahlungsschein, «${name}» wird aber per ${label} bezahlt.` });
  }
  if (ibanEndung !== null && ibanEndung !== undefined && !ibanEndungPasst(db, kreditor.id, ibanEndung)) {
    const endung = normalizeIban(String(ibanEndung).trim());
    befunde.push({ code: 'iban_manuell_fremd', schwere: 'rot', titel: 'IBAN nicht hinterlegt (manuelle Prüfung)',
      text: `Die letzten 4 Zeichen (${endung}) passen zu keiner hinterlegten IBAN von «${name}».` });
  }
  if (job.qr_creditor_name && !namenPassen(job.qr_creditor_name, name)) {
    befunde.push({ code: 'name', schwere: 'gelb', titel: 'Name weicht ab',
      text: `Zahlungsempfänger im QR-Code: «${job.qr_creditor_name}» · Lieferant: «${name}»` });
  }

  const betragRp = rappen(betrag);
  if (betragRp !== null) {
    // Ein Splitkind erbt den QR-Betrag der ganzen Rechnung (createSplitJob): verglichen mit seinem
    // Teilbetrag gäbe das bei jeder Kontierung eines Kindes einen falschen Befund. Der Gesamtbetrag
    // wurde beim Aufsplitten bereits gegen den QR-Betrag geprüft.
    const qrRp = job.aufgesplittet_von ? null : rappen(job.qr_betrag);
    if (qrRp !== null && qrRp !== betragRp) {
      befunde.push({ code: 'betrag_qr', schwere: 'gelb', titel: 'Betrag weicht ab', text: `QR-Code: ${fmt(qrRp)} · kontiert: ${fmt(betragRp)}` });
    }
    if (typ === 'rechnung') befunde.push(...betragsBefunde(db, { job, kreditor, betragRp, rechnungsnummer, fmt }));
  }

  return befunde.sort((a, b) => (a.schwere === b.schwere ? 0 : a.schwere === 'rot' ? -1 : 1)
    || CODE_REIHENFOLGE.indexOf(a.code) - CODE_REIHENFOLGE.indexOf(b.code));
}

// E/F/G — nur für Typ Rechnung.
// Betragsprüfungen (ungewöhnlich hoch, neuer Lieferant mit hohem Betrag, gleicher Betrag kurz hintereinander); Schwellen aus admin_config (pruefung_*).
function betragsBefunde(db, { job, kreditor, betragRp, rechnungsnummer, fmt }) {
  const befunde = [];
  const jetzt = Date.now();
  const frueher = fruehereRechnungen(db, kreditor.id, job.id);

  const minAnzahl = schwelle(db, 'pruefung_betrag_min_rechnungen');
  if (!kreditor.betrag_schwankt) {
    const vor12Monaten = new Date(jetzt);
    vor12Monaten.setMonth(vor12Monaten.getMonth() - 12);
    const letzte12 = frueher.filter((r) => r.zeitpunkt >= vor12Monaten.getTime());
    const basis = letzte12.length >= minAnzahl ? letzte12 : frueher;
    if (basis.length > 0 && basis.length >= minAnzahl) {
      const schnitt = basis.reduce((summe, r) => summe + r.rappen, 0) / basis.length;
      if (schnitt > 0 && betragRp >= schwelle(db, 'pruefung_betrag_faktor') * schnitt
        && betragRp >= schwelle(db, 'pruefung_betrag_minimum') * 100) {
        befunde.push({ code: 'betrag_hoch', schwere: 'gelb', titel: 'Ungewöhnlich hoher Betrag',
          text: `${Math.round(betragRp / schnitt)}-mal so hoch wie der Durchschnitt der letzten ${basis.length} Rechnungen (${fmt(Math.round(schnitt))})` });
      }
    }
  }

  if (frueher.length === 0 && betragRp > schwelle(db, 'pruefung_neuer_kreditor_betrag') * 100) {
    befunde.push({ code: 'neuer_kreditor', schwere: 'gelb', titel: 'Neuer Lieferant, hoher Betrag',
      text: `Erste Rechnung von «${kreditor.name}» über ${fmt(betragRp)}.` });
  }

  if (kreditor.zahlungsart !== 'dauerauftrag' && kreditor.zahlungsart !== 'lastschrift') {
    const tage = schwelle(db, 'pruefung_gleicher_betrag_tage');
    const gleiche = frueher
      .filter((r) => r.rappen === betragRp && r.zeitpunkt >= jetzt - tage * TAG_MS && !gleicheNummer(r.rechnungsnummer, rechnungsnummer))
      .sort((a, b) => b.zeitpunkt - a.zeitpunkt);
    if (gleiche.length > 0) {
      befunde.push({ code: 'gleicher_betrag', schwere: 'gelb', titel: 'Gleicher Betrag kurz hintereinander',
        text: `Gleicher Betrag wie Rechnung ${gleiche.map((r) => `#${r.id}`).join(', ')} vom ${DATUM.format(new Date(gleiche[0].zeitpunkt))} (innerhalb von ${tage} Tagen).` });
    }
  }
  return befunde;
}
