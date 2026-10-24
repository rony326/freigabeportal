import { pruefeAuditExportRegister } from './auditExport.js';
import { pruefeAuditZeitstempelToken } from './auditZeitstempel.js';
import { ladeAuditZeitstempel } from './auditNachweisJobs.js';
import { getConfigValue } from '../db/adminConfigRepo.js';

// Oeffentliche Pruefung einer Audit-Pruefnummer (paket_sha256) fuer die Revision.
// Ergebnis enthaelt nur Paketnummern, Hashes, Anzahlen und Zeitpunkte, nie Personendaten.

const VORLAUF_MS = 5 * 60 * 1000;
const NACHLAUF_MS = 7 * 24 * 3600 * 1000;

const BEFUND_TEXTE = {
  paket_hash_abweichend: 'Prüfnummer passt nicht mehr zu den Paketangaben',
  kette_unterbrochen: 'Verkettung mit dem vorherigen Paket unterbrochen',
  bereich_nicht_anschliessend: 'Bereich schliesst nicht an das vorherige Paket an',
  inhalt_abweichend: 'Inhalt weicht vom heutigen Audit-Log ab',
};

export function normalisierePruefnummer(eingabe) {
  if (typeof eingabe !== 'string') return null;
  const wert = eingabe.replace(/[\s-]/g, '').toLowerCase();
  return /^[0-9a-f]{64}$/.test(wert) ? wert : null;
}

// 'ok' | 'fehlt' | 'ungueltig' | 'verspaetet' | 'zu_frueh'
async function zeitstempelStatus(db, paket) {
  const zeile = ladeAuditZeitstempel(db, paket.id);
  if (!zeile) return 'fehlt';
  const pruefung = await pruefeAuditZeitstempelToken(zeile.token, paket.paket_sha256);
  if (!pruefung.gueltig || !pruefung.genTime) return 'ungueltig';
  const erstellt = Date.parse(paket.erstellt_am);
  const gen = pruefung.genTime.getTime();
  if (!Number.isFinite(erstellt)) return 'ungueltig';
  if (gen < erstellt - VORLAUF_MS) return 'zu_frueh';
  if (gen > erstellt + NACHLAUF_MS) return 'verspaetet';
  return 'ok';
}

const liste = (nummern) => nummern.map((nr) => `Paket ${nr}`).join(', ');

function zeitstempelText(db, paketNr, maengel, spaet = false) {
  if (!spaet && !Object.values(maengel).some((n) => n.length)) {
    return paketNr === 1
      ? 'Paket 1 hat einen gültigen, rechtzeitig gesetzten Zeitstempel, der zum Paket passt.'
      : `Paket ${paketNr} und alle älteren Pakete haben einen gültigen, rechtzeitig gesetzten Zeitstempel, der zum jeweiligen Paket passt.`;
  }
  const teile = [];
  if (maengel.fehlt.length) {
    const ohneTsa = getConfigValue(db, 'zeitstempel_tsa_url') ? '' : ' (kein Zeitstempeldienst konfiguriert)';
    teile.push(`Ohne Zeitstempel${ohneTsa}: ${liste(maengel.fehlt)}.`);
  }
  if (maengel.ungueltig.length) teile.push(`Zeitstempel ungültig oder passt nicht zum Paket: ${liste(maengel.ungueltig)}.`);
  if (!teile.length) {
    return paketNr === 1
      ? 'Paket 1 hat einen gültigen Zeitstempel, der zum Paket passt.'
      : `Paket ${paketNr} und alle älteren Pakete haben einen gültigen Zeitstempel, der zum jeweiligen Paket passt.`;
  }
  return teile.join(' ');
}

export async function pruefeAuditNachweis(db, { paketNr, pruefnummer }) {
  const neuereLeer = { anzahl: 0, alleGestempelt: true };
  const pakete = db.prepare('SELECT * FROM audit_export_pakete ORDER BY id').all();
  if (!pakete.length) return { status: 'kein_paket', punkte: [], neuere: neuereLeer };
  const paket = pakete.find((p) => p.id === paketNr);
  if (!paket) return { status: 'unbekannt', punkte: [], neuere: neuereLeer };

  const punkte = [];
  const nummerOk = normalisierePruefnummer(pruefnummer) === paket.paket_sha256;
  punkte.push({
    titel: 'Prüfnummer',
    ok: nummerOk,
    text: nummerOk
      ? `Die Prüfnummer stimmt mit Paket ${paket.id} überein.`
      : `Die Prüfnummer stimmt nicht mit Paket ${paket.id} überein.`,
  });

  const register = pruefeAuditExportRegister(db);
  punkte.push({
    titel: 'Verkettung und Inhalt',
    ok: register.befunde.length === 0,
    text: register.befunde.length === 0
      ? `Alle ${register.pakete} Pakete sind lückenlos verkettet und stimmen mit dem heutigen Audit-Log überein.`
      : register.befunde.map(({ paketNr: nr, befund }) => `Paket ${nr}: ${BEFUND_TEXTE[befund] ?? 'Abweichung festgestellt'}.`).join(' '),
  });

  const maengel = { fehlt: [], ungueltig: [], verspaetet: [], zu_frueh: [] };
  let neuereAlleGestempelt = true;
  for (const p of pakete) {
    const status = await zeitstempelStatus(db, p);
    if (p.id <= paket.id) {
      if (status !== 'ok') maengel[status].push(p.id);
    } else if (status !== 'ok') {
      neuereAlleGestempelt = false;
    }
  }
  // Verspaetet gesetzte Stempel sind nur ein Hinweis (amber), fehlende/ungueltige bleiben rot.
  const hinweise = [];
  if (maengel.verspaetet.length) hinweise.push(`Zeitstempel verspätet gesetzt (mehr als 7 Tage nach Erstellung des Pakets): ${liste(maengel.verspaetet)}.`);
  if (maengel.zu_frueh.length) hinweise.push(`Zeitstempel verspätet gesetzt bzw. zeitlich nicht passend (vor der Erstellung des Pakets): ${liste(maengel.zu_frueh)}.`);
  const harteMaengel = { fehlt: maengel.fehlt, ungueltig: maengel.ungueltig };
  punkte.push({
    titel: 'Zeitstempel',
    ok: maengel.fehlt.length === 0 && maengel.ungueltig.length === 0,
    text: zeitstempelText(db, paket.id, harteMaengel, hinweise.length > 0),
    hinweise,
  });

  return {
    status: punkte.every((p) => p.ok) ? 'ok' : 'abweichung',
    punkte,
    neuere: { anzahl: pakete.filter((p) => p.id > paket.id).length, alleGestempelt: neuereAlleGestempelt },
  };
}
