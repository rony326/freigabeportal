// Globaler, durchsuchbarer Audit-Log (Admin → Audit-Log, docs/admin-bereich.md): Zeitleiste über alle Vorgänge aus `freigaben`,
// `job_loeschungen` und den Kreditkartenbeleg-Ereignissen. Das ist NICHT die unveränderliche Tabelle `audit_ereignisse`
// (Datenbank-Trigger, docs/auth-und-rechte.md), sondern die fachliche Sicht auf den Verlauf.

import { getConfigValue } from '../db/adminConfigRepo.js';
import { EREIGNIS_LABEL, personName, formatZeitpunkt } from './auditLog.js';

// Gemeinsame Basis: vereinigt die drei Quellen zu einheitlichen Spalten (Zeitpunkt, Quelle, Ereignistyp, Person, Vorgang, Konto, Kommentar).
const BASE_QUERY = `
  WITH audit AS (
    SELECT
      f.zeitpunkt AS zeitpunkt,
      f.id AS row_id,
      'freigabe' AS quelle,
      f.rolle AS ereignis_typ,
      f.person_id AS person_id,
      f.job_id AS job_id,
      j.dateiname AS dateiname,
      j.konto_id AS konto_id,
      k.bezeichnung AS konto_bezeichnung,
      f.kommentar AS kommentar,
      j.status AS job_status
    FROM freigaben f
    LEFT JOIN jobs j ON j.id = f.job_id
    LEFT JOIN konten k ON k.id = j.konto_id
    UNION ALL
    SELECT
      jl.zeitpunkt AS zeitpunkt,
      jl.id AS row_id,
      'loeschung' AS quelle,
      'loeschung' AS ereignis_typ,
      jl.geloescht_von AS person_id,
      jl.job_id AS job_id,
      jl.dateiname AS dateiname,
      j.konto_id AS konto_id,
      k.bezeichnung AS konto_bezeichnung,
      jl.begruendung AS kommentar,
      j.status AS job_status
    FROM job_loeschungen jl
    LEFT JOIN jobs j ON j.id = jl.job_id
    LEFT JOIN konten k ON k.id = j.konto_id
    UNION ALL
    SELECT
      e.zeitpunkt AS zeitpunkt,
      e.id AS row_id,
      'kk_beleg' AS quelle,
      e.aktion AS ereignis_typ,
      e.person_id AS person_id,
      b.zugeordnet_job_id AS job_id,
      'Kreditkartenbeleg #' || b.id || COALESCE(' — ' || b.beschreibung, '') AS dateiname,
      b.konto_id AS konto_id,
      k.bezeichnung AS konto_bezeichnung,
      e.kommentar AS kommentar,
      b.status AS job_status
    FROM kk_beleg_ereignisse e
    JOIN kk_belege b ON b.id = e.beleg_id
    LEFT JOIN konten k ON k.id = b.konto_id
  )
`;

// Baut die WHERE-Klausel aus den Filtern (Person, Konto, Zeitraum, Ereignistyp, Suchbegriff) – nur gebundene Parameter.
function buildWhere(filter) {
  const clauses = [];
  const params = [];
  if (filter.personId) {
    clauses.push('person_id = ?');
    params.push(filter.personId);
  }
  if (filter.kontoId) {
    clauses.push('konto_id = ?');
    params.push(filter.kontoId);
  }
  if (filter.von) {
    clauses.push('zeitpunkt >= ?');
    params.push(filter.von);
  }
  if (filter.bis) {
    clauses.push('zeitpunkt <= ?');
    params.push(filter.bis);
  }
  if (filter.ereignisTyp) {
    clauses.push('ereignis_typ = ?');
    params.push(filter.ereignisTyp);
  }
  if (filter.suchbegriff) {
    // % und _ sind LIKE-Platzhalter; sie werden maskiert, damit die Suche nach einem wörtlichen Dateinamen-Fragment wie
    // "a_b.pdf" nicht über SQLites Einzelzeichen-Platzhalter auch "axb.pdf" trifft.
    clauses.push("(kommentar LIKE ? ESCAPE '\\' OR dateiname LIKE ? ESCAPE '\\')");
    const muster = `%${escapeLikeMuster(filter.suchbegriff)}%`;
    params.push(muster, muster);
  }
  return { where: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

// Maskiert \, % und _ für LIKE ... ESCAPE '\'.
function escapeLikeMuster(text) {
  return text.replace(/[\\%_]/g, (match) => `\\${match}`);
}

// Aggregiert freigaben (alle Jobs) und job_loeschungen zu einer gemeinsamen, durchsuchbaren
// Zeitleiste. Filter/Pagination laufen komplett in SQL (nicht in JS über geladene Zeilen) --
// entscheidend für eine global wachsende Tabelle, im Gegensatz zum job-lokalen buildAuditLog.
//
// filter.bis muss bereits ein inklusives Tagesende sein (z.B. "...T23:59:59.999Z"), nicht ein
// bloßes Datum -- der Aufrufer (siehe src/routes/admin/auditLog.js) ist dafür verantwortlich,
// ein reines Datum entsprechend zu erweitern, bevor er hier ankommt.
/**
 * @param {object} filter `{personId, kontoId, von, bis, ereignisTyp, suchbegriff}`; `bis` muss ein inklusives Tagesende sein
 * @param {{seite?: number, proSeite?: number}} [paging]
 * @returns {{eintraege: object[], gesamtAnzahl: number, seite: number, proSeite: number}}
 */
export function queryGlobalAuditLog(db, filter = {}, { seite = 1, proSeite = 50 } = {}) {
  // Eine nicht positive oder nicht ganzzahlige seite/proSeite darf nie ungeklemmt in die SQL-Klausel LIMIT/OFFSET gelangen:
  // SQLite behandelt ein negatives LIMIT als "keine Obergrenze" und würde still die gesamte, unbegrenzte Audit-Tabelle statt
  // einer Seite davon zurückgeben.
  const seiteGewuenscht = Math.max(1, Math.trunc(seite) || 1);
  const proSeiteSicher = Math.max(1, Math.trunc(proSeite) || 50);

  const { where, params } = buildWhere(filter);
  const lokaleZeit = getConfigValue(db, 'audit_log_lokale_zeit') === '1';

  const gesamtAnzahl = db.prepare(`${BASE_QUERY} SELECT COUNT(*) AS anzahl FROM audit ${where}`).get(...params).anzahl;

  // Eine seite jenseits der letzten tatsächlich vorhandenen Seite (z.B. nach einer Löschung von
  // Einträgen oder einer von Hand editierten URL) fängt hier ab statt eine leere Seite ohne Weg
  // zurück zu rendern -- die letzte gültige Seite wird stattdessen angezeigt.
  const gesamtSeiten = Math.max(1, Math.ceil(gesamtAnzahl / proSeiteSicher));
  const seiteSicher = Math.min(seiteGewuenscht, gesamtSeiten);

  const offset = (seiteSicher - 1) * proSeiteSicher;
  const rows = db
    .prepare(`${BASE_QUERY} SELECT * FROM audit ${where} ORDER BY zeitpunkt DESC, row_id DESC LIMIT ? OFFSET ?`)
    .all(...params, proSeiteSicher, offset);

  const eintraege = rows.map((row) => ({
    zeitpunkt: formatZeitpunkt(row.zeitpunkt, lokaleZeit),
    ereignis: EREIGNIS_LABEL[row.ereignis_typ] || row.ereignis_typ,
    quelle: row.quelle,
    person: row.person_id ? personName(db, row.person_id) : 'System',
    jobId: row.job_id,
    dateiname: row.dateiname,
    kontoBezeichnung: row.konto_bezeichnung,
    kommentar: row.kommentar,
    jobStatus: row.job_status,
  }));

  return { eintraege, gesamtAnzahl, seite: seiteSicher, proSeite: proSeiteSicher };
}
