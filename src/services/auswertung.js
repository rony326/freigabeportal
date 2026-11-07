// Auswertung der Rechnungen: Kennzahlen, Budget pro Konto, Durchlaufzeiten, Engpässe, Lieferanten.
// Reine Lesefunktionen; jede Funktion bekommt den Zeitraum als Zürcher Datum (YYYY-MM-DD) und
// optional eine Liste erlaubter Konto-IDs (null = alle Konten).
//
// Zählregeln (auch auf der Seite erklärt):
// - "freigegeben" = Status abgeschlossen/abgeholt/archiviert, Zeitraum über das Zürcher Datum von
//   abgeschlossen_am.
// - Gutschriften zählen negativ. Abgelehnte, gelöschte und aufgesplittete Eltern (Splitgruppen,
//   Kreditkarten-Abrechnungen) zählen nie; ihre Teile zählen je Konto. Rapporte sind keine
//   Rechnungen und zählen nirgends.

import { listBudgetsFuerJahr } from '../db/budgetRepo.js';
import { personHasPermission } from '../middleware/permissions.js';
import { ermittleZustaendigkeit } from './vorgangZustaendigkeit.js';

const ZEITZONE = 'Europe/Zurich';
const FREIGEGEBEN = "j.status IN ('abgeschlossen','abgeholt','archiviert')";
const KEIN_RAPPORT = "(j.typ IS NULL OR j.typ <> 'rapport')";
const BETRAG = "(CASE WHEN j.typ = 'gutschrift' THEN -1 ELSE 1 END) * COALESCE(CAST(j.betrag AS REAL), 0)";
const IN_FREIGABE = ['zugewiesen', 'freigabe2'];
const OFFEN = ['unzugewiesen', ...IN_FREIGABE];
const ENGPASS_STATUS = ['unzugewiesen', 'zugewiesen', 'freigabe2', 'abgelehnt'];
const TAG_MS = 24 * 60 * 60 * 1000;
const MAX_JAHRE = 5;

// ---------- Datum ----------

const tagFormat = new Intl.DateTimeFormat('en-CA', { timeZone: ZEITZONE, year: 'numeric', month: '2-digit', day: '2-digit' });

export function zuerichDatum(iso) {
  return tagFormat.format(new Date(iso));
}

export function zuerichHeute() {
  return zuerichDatum(new Date().toISOString());
}

// UTC-Zeitpunkt (ISO) von 00:00 Zürcher Zeit am angegebenen Tag.
function zuerichMitternachtUtc(datum) {
  const [y, m, d] = datum.split('-').map(Number);
  const geraten = Date.UTC(y, m - 1, d);
  let ergebnis = geraten;
  // Zweimal korrigieren, damit auch Tage mit Zeitumstellung stimmen.
  for (let i = 0; i < 2; i++) {
    const teile = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
      timeZone: ZEITZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(ergebnis)).map((t) => [t.type, t.value]));
    const wand = Date.UTC(Number(teile.year), Number(teile.month) - 1, Number(teile.day), Number(teile.hour), Number(teile.minute));
    ergebnis -= wand - geraten;
  }
  return new Date(ergebnis).toISOString();
}

function plusTage(datum, tage) {
  const [y, m, d] = datum.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + tage)).toISOString().slice(0, 10);
}

function tageZwischen(vonDatum, bisDatum) {
  return Math.round((Date.parse(`${bisDatum}T00:00:00Z`) - Date.parse(`${vonDatum}T00:00:00Z`)) / TAG_MS);
}

function istDatum(text) {
  if (typeof text !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const [y, m, d] = text.split('-').map(Number);
  const datum = new Date(Date.UTC(y, m - 1, d));
  return datum.getUTCFullYear() === y && datum.getUTCMonth() === m - 1 && datum.getUTCDate() === d;
}

// UTC-Grenzen [ab, bisExklusiv) für einen Zürcher Datumsbereich.
function utcGrenzen(von, bis) {
  return { ab: zuerichMitternachtUtc(von), bisExklusiv: zuerichMitternachtUtc(plusTage(bis, 1)) };
}

export function parseZeitraum(query = {}, heute = zuerichHeute()) {
  const jahr = Number(heute.slice(0, 4));
  const standard = { art: 'jahr', von: `${jahr}-01-01`, bis: heute, budgetJahr: jahr };
  const art = query.zeitraum || 'jahr';
  if (art === 'jahr') return standard;
  if (art === '12m') return { art, von: plusTage(heute, -365), bis: heute, budgetJahr: jahr };
  if (art === 'vorjahr') return { art, von: `${jahr - 1}-01-01`, bis: `${jahr - 1}-12-31`, budgetJahr: jahr - 1 };
  if (art === 'eigen') {
    const { von, bis } = query;
    if (!istDatum(von) || !istDatum(bis)) return { ...standard, fehler: 'Bitte ein gültiges Von- und Bis-Datum angeben.' };
    if (von > bis) return { ...standard, fehler: 'Das Von-Datum muss vor dem Bis-Datum liegen.' };
    const [by, bm, bd] = bis.split('-');
    if (von < `${Number(by) - MAX_JAHRE}-${bm}-${bd}`) return { ...standard, fehler: `Der Zeitraum darf höchstens ${MAX_JAHRE} Jahre umfassen.` };
    return { art, von, bis, budgetJahr: Number(by) };
  }
  return { ...standard, fehler: 'Unbekannter Zeitraum.' };
}

// ---------- Zahlen ----------

export function median(werte) {
  if (!werte.length) return null;
  const s = [...werte].sort((a, b) => a - b);
  const mitte = Math.floor(s.length / 2);
  return s.length % 2 ? s[mitte] : (s[mitte - 1] + s[mitte]) / 2;
}

// 90. Perzentil nach Nearest-Rank: das ceil(0.9·n)-te Element der sortierten Werte.
export function perzentil90(werte) {
  if (!werte.length) return null;
  const s = [...werte].sort((a, b) => a - b);
  return s[Math.ceil(0.9 * s.length) - 1];
}

function runde(wert, stellen) {
  if (wert === null) return null;
  const f = 10 ** stellen;
  return Math.round(wert * f) / f;
}

export function formatChf(betrag) {
  const wert = Math.round((Number(betrag) || 0) * 100) / 100;
  const [ganz, rest] = Math.abs(wert).toFixed(2).split('.');
  return `CHF ${wert < 0 ? '-' : ''}${ganz.replace(/\B(?=(\d{3})+(?!\d))/g, "'")}.${rest}`;
}

// Liest Beträge so, wie sie in Excel-Listen vorkommen: "12'000.–", "12 000,50", "CHF 1500".
// Negative oder unlesbare Werte → null.
export function parseBetrag(text) {
  if (text === null || text === undefined) return null;
  let s = String(text).trim().replace(/^CHF\s*/i, '').replace(/[\s'’ ]/g, '').replace(/[.,][-–—]$/, '');
  if (!s) return null;
  if (s.includes(',') && !s.includes('.')) s = s.replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  return Number(s);
}

// ---------- Zugang ----------

export function zugangFuer(db, config, person) {
  if (!person) return null;
  if (personHasPermission(db, config, person, 'auswertung_einsehen')) return { alle: true, kontoIds: null, engpaesse: true };
  const pid = person.churchtools_person_id;
  const kontoIds = db.prepare('SELECT id FROM konten WHERE aktiv = 1 AND (freigeber1_id = ? OR stellvertreter1_id = ?) ORDER BY kontonummer, id')
    .all(pid, pid).map((k) => k.id);
  return kontoIds.length ? { alle: false, kontoIds, engpaesse: false } : null;
}

// ---------- SQL-Bausteine ----------

function kontoFilter(kontoIds) {
  if (kontoIds === null || kontoIds === undefined) return { sql: '', params: [] };
  if (!kontoIds.length) return { sql: ' AND 0', params: [] };
  return { sql: ` AND j.konto_id IN (${kontoIds.map(() => '?').join(',')})`, params: kontoIds };
}

function platzhalter(liste) {
  return liste.map(() => '?').join(',');
}

function freigegebeneJobs(db, { von, bis, kontoIds }, spalten = 'j.*') {
  const { ab, bisExklusiv } = utcGrenzen(von, bis);
  const kf = kontoFilter(kontoIds);
  return db.prepare(`SELECT ${spalten}, ${BETRAG} AS wert FROM jobs j
    WHERE ${FREIGEGEBEN} AND ${KEIN_RAPPORT} AND j.abgeschlossen_am >= ? AND j.abgeschlossen_am < ?${kf.sql}`)
    .all(ab, bisExklusiv, ...kf.params);
}

function personenNamen(db) {
  const map = new Map();
  for (const p of db.prepare('SELECT churchtools_person_id AS id, vorname, nachname FROM personen').all()) {
    map.set(p.id, `${p.vorname ?? ''} ${p.nachname ?? ''}`.trim());
  }
  return map;
}

// ---------- Kennzahlen ----------

export function kennzahlen(db, { von, bis, kontoIds, schwelleTage, heute = zuerichHeute() }) {
  const freigegeben = freigegebeneJobs(db, { von, bis, kontoIds });
  const kf = kontoFilter(kontoIds);
  const offene = db.prepare(`SELECT j.status, j.eingang_am, j.betrag, j.qr_waehrung, ${BETRAG} AS wert FROM jobs j
    WHERE j.status IN (${platzhalter(OFFEN)}) AND ${KEIN_RAPPORT}${kf.sql}`).all(...OFFEN, ...kf.params);
  const alter = offene.map((j) => tageZwischen(zuerichDatum(j.eingang_am), heute));
  const lange = alter.filter((t) => t > schwelleTage);
  const dauer = freigegeben.map((j) => (Date.parse(j.abgeschlossen_am) - Date.parse(j.eingang_am)) / TAG_MS);
  const gezaehlt = [...freigegeben, ...offene];
  return {
    freigegeben: { betrag: runde(summe(freigegeben), 2), anzahl: freigegeben.length },
    inFreigabe: { betrag: runde(summe(offene), 2), anzahl: offene.length },
    medianTage: runde(median(dauer), 1),
    langeOffen: { anzahl: lange.length, aeltesteTage: lange.length ? Math.max(...lange) : null },
    ohneBetrag: gezaehlt.filter((j) => j.betrag === null || j.betrag === undefined || j.betrag === '').length,
    inEur: gezaehlt.filter((j) => j.qr_waehrung === 'EUR').length,
  };
}

function summe(zeilen) {
  return zeilen.reduce((s, z) => s + z.wert, 0);
}

// ---------- Budget pro Konto ----------

// Ausgaben im Budget-Abschnitt stammen nur aus dem Budget-Jahr (innerhalb des Zeitraums), damit
// die Ausschöpfung mit dem Jahresbudget vergleichbar bleibt.
export function budgetProKonto(db, { von, bis, budgetJahr, kontoIds }) {
  const jahrVon = `${budgetJahr}-01-01`;
  const jahrBis = `${budgetJahr}-12-31`;
  const effVon = von > jahrVon ? von : jahrVon;
  const effBis = bis < jahrBis ? bis : jahrBis;
  const freigegeben = new Map();
  if (effVon <= effBis) {
    for (const j of freigegebeneJobs(db, { von: effVon, bis: effBis, kontoIds }, 'j.konto_id')) {
      freigegeben.set(j.konto_id, (freigegeben.get(j.konto_id) ?? 0) + j.wert);
    }
  }
  const kf = kontoFilter(kontoIds);
  const inFreigabe = new Map(db.prepare(`SELECT j.konto_id, SUM(${BETRAG}) AS wert FROM jobs j
    WHERE j.status IN (${platzhalter(IN_FREIGABE)}) AND ${KEIN_RAPPORT} AND j.konto_id IS NOT NULL${kf.sql} GROUP BY j.konto_id`)
    .all(...IN_FREIGABE, ...kf.params).map((r) => [r.konto_id, r.wert]));
  const budgets = listBudgetsFuerJahr(db, budgetJahr);
  const namen = personenNamen(db);
  const kontoSql = kf.sql.replaceAll('j.konto_id', 'k.id');
  const konten = db.prepare(`SELECT k.* FROM konten k WHERE k.aktiv = 1${kontoSql} ORDER BY k.kontonummer, k.id`).all(...kf.params);
  return konten.map((k) => {
    const budget = budgets.has(k.id) ? budgets.get(k.id) : null;
    const f = runde(freigegeben.get(k.id) ?? 0, 2);
    return {
      kontoId: k.id,
      kontonummer: k.kontonummer,
      bezeichnung: k.bezeichnung,
      verantwortlich: namen.get(k.freigeber1_id) || null,
      budget,
      freigegeben: f,
      inFreigabe: runde(inFreigabe.get(k.id) ?? 0, 2),
      ausschoepfung: budget ? runde(f / budget, 4) : null,
      ueberBudget: budget !== null && f > budget,
    };
  });
}

// ---------- Durchlaufzeiten ----------

function poolEnde(db, job) {
  const audit = db.prepare(`SELECT MIN(zeitpunkt) AS t FROM audit_ereignisse
    WHERE objekt = 'jobs' AND objekt_id = ? AND aktion = 'UPDATE'
      AND json_extract(vorher, '$.status') = 'unzugewiesen' AND json_extract(nachher, '$.status') <> 'unzugewiesen'`).get(String(job.id)).t;
  const zuweisung = db.prepare("SELECT MIN(zeitpunkt) AS t FROM freigaben WHERE job_id = ? AND rolle = 'pool_zuweisung'").get(job.id).t;
  const kandidaten = [audit, zuweisung].filter(Boolean).sort();
  return kandidaten[0] ?? job.eingang_am;
}

function tage(vonIso, bisIso) {
  return Math.max(0, (Date.parse(bisIso) - Date.parse(vonIso)) / TAG_MS);
}

export function durchlaufzeiten(db, { von, bis, kontoIds }) {
  const werte = { pool: [], freigabe1: [], freigabe2: [] };
  for (const job of freigegebeneJobs(db, { von, bis, kontoIds }, 'j.id, j.eingang_am, j.abgeschlossen_am')) {
    const ende = poolEnde(db, job);
    werte.pool.push(tage(job.eingang_am, ende));
    const f1 = db.prepare("SELECT MAX(zeitpunkt) AS t FROM freigaben WHERE job_id = ? AND rolle = 'freigeber1'").get(job.id).t;
    if (f1) {
      werte.freigabe1.push(tage(ende, f1));
      werte.freigabe2.push(tage(f1, job.abgeschlossen_am));
    } else {
      werte.freigabe2.push(tage(ende, job.abgeschlossen_am));
    }
  }
  return Object.entries(werte).map(([stufe, liste]) => ({
    stufe, median: runde(median(liste), 1), p90: runde(perzentil90(liste), 1), anzahl: liste.length,
  }));
}

// ---------- Engpässe ----------

function stufeVon(job) {
  if (job.status === 'unzugewiesen') return 'Pool';
  if (job.status === 'freigabe2') return 'Freigabe 2';
  if (job.status === 'abgelehnt') return 'Überarbeitung';
  return job.quelle === 'spesen' ? 'Spesen-Freigabe 1' : 'Kontierung & Freigabe 1';
}

// Seit wann steht der Job in seiner aktuellen Stufe bei der aktuellen Person?
function stufeSeit(db, job) {
  if (job.status === 'freigabe2' && job.freigabe2_seit) return job.freigabe2_seit;
  const t = db.prepare(`SELECT MAX(zeitpunkt) AS t FROM audit_ereignisse
    WHERE objekt = 'jobs' AND objekt_id = ? AND aktion = 'UPDATE'
      AND json_extract(nachher, '$.status') = ? AND json_extract(nachher, '$.zugewiesen_an') IS ?
      AND (json_extract(vorher, '$.status') IS NOT ? OR json_extract(vorher, '$.zugewiesen_an') IS NOT ?)`)
    .get(String(job.id), job.status, job.zugewiesen_an, job.status, job.zugewiesen_an).t;
  return t ?? job.eingang_am;
}

export function engpaesse(db, { kontoIds, heute = zuerichHeute() }) {
  const kf = kontoFilter(kontoIds);
  const jobs = db.prepare(`SELECT j.* FROM jobs j WHERE j.status IN (${platzhalter(ENGPASS_STATUS)}) AND ${KEIN_RAPPORT}${kf.sql}`)
    .all(...ENGPASS_STATUS, ...kf.params);
  const namen = personenNamen(db);
  const gruppen = new Map();
  for (const job of jobs) {
    const z = ermittleZustaendigkeit(db, job);
    if (z.art === 'keine') continue;
    const stufe = stufeVon(job);
    const schluessel = `${z.art}|${z.personId ?? ''}|${stufe}`;
    const alter = tageZwischen(zuerichDatum(stufeSeit(db, job)), heute);
    const name = z.art === 'pool' ? 'Pool' : z.art === 'admin' ? 'Admin-Gruppe' : (namen.get(z.personId) || '(niemand zugewiesen)');
    const g = gruppen.get(schluessel) ?? { personId: z.personId, name, art: z.art, stufe, anzahl: 0, aeltesteTage: 0 };
    g.anzahl += 1;
    g.aeltesteTage = Math.max(g.aeltesteTage, alter);
    gruppen.set(schluessel, g);
  }
  return [...gruppen.values()].sort((a, b) => b.aeltesteTage - a.aeltesteTage || b.anzahl - a.anzahl || a.name.localeCompare(b.name, 'de'));
}

// ---------- Lieferanten ----------

export function lieferanten(db, { von, bis, kontoIds }) {
  const { ab, bisExklusiv } = utcGrenzen(von, bis);
  const kf = kontoFilter(kontoIds);
  const jobs = db.prepare(`SELECT j.quelle, kr.name AS kreditor, ko.kontonummer, ${BETRAG} AS wert FROM jobs j
    LEFT JOIN kreditoren kr ON kr.id = j.kreditor_id LEFT JOIN konten ko ON ko.id = j.konto_id
    WHERE ${FREIGEGEBEN} AND ${KEIN_RAPPORT} AND j.abgeschlossen_am >= ? AND j.abgeschlossen_am < ?${kf.sql}`)
    .all(ab, bisExklusiv, ...kf.params);
  const gruppen = new Map();
  for (const j of jobs) {
    const name = j.kreditor || (j.quelle === 'spesen' ? 'Spesen (Rückerstattung)' : '(kein Kreditor)');
    const g = gruppen.get(name) ?? { name, anzahl: 0, betrag: 0, konten: new Map() };
    g.anzahl += 1;
    g.betrag += j.wert;
    if (j.kontonummer) g.konten.set(j.kontonummer, (g.konten.get(j.kontonummer) ?? 0) + j.wert);
    gruppen.set(name, g);
  }
  const total = summe(jobs);
  return [...gruppen.values()]
    .map((g) => ({
      name: g.name,
      anzahl: g.anzahl,
      betrag: runde(g.betrag, 2),
      anteil: total > 0 ? runde(g.betrag / total, 3) : 0,
      konten: [...g.konten.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 2).map(([nr]) => nr),
    }))
    .sort((a, b) => b.betrag - a.betrag || a.name.localeCompare(b.name, 'de'));
}
