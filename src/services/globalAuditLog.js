import { getConfigValue } from '../db/adminConfigRepo.js';
import { EREIGNIS_LABEL, personName, formatZeitpunkt } from './auditLog.js';

const BASE_QUERY = `
  WITH audit AS (
    SELECT
      f.zeitpunkt AS zeitpunkt,
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
  )
`;

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
    clauses.push('(kommentar LIKE ? OR dateiname LIKE ?)');
    const muster = `%${filter.suchbegriff}%`;
    params.push(muster, muster);
  }
  return { where: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

// Aggregiert freigaben (alle Jobs) und job_loeschungen zu einer gemeinsamen, durchsuchbaren
// Zeitleiste. Filter/Pagination laufen komplett in SQL (nicht in JS über geladene Zeilen) --
// entscheidend für eine global wachsende Tabelle, im Gegensatz zum job-lokalen buildAuditLog.
export function queryGlobalAuditLog(db, filter = {}, { seite = 1, proSeite = 50 } = {}) {
  // A non-positive or non-integer seite/proSeite must never reach the SQL LIMIT/OFFSET clause
  // unclamped: SQLite treats a negative LIMIT as "no upper bound", which would silently return
  // the entire, unbounded audit table instead of a page of it.
  const seiteSicher = Math.max(1, Math.trunc(seite) || 1);
  const proSeiteSicher = Math.max(1, Math.trunc(proSeite) || 50);

  const { where, params } = buildWhere(filter);
  const lokaleZeit = getConfigValue(db, 'audit_log_lokale_zeit') === '1';

  const gesamtAnzahl = db.prepare(`${BASE_QUERY} SELECT COUNT(*) AS anzahl FROM audit ${where}`).get(...params).anzahl;

  const offset = (seiteSicher - 1) * proSeiteSicher;
  const rows = db
    .prepare(`${BASE_QUERY} SELECT * FROM audit ${where} ORDER BY zeitpunkt DESC LIMIT ? OFFSET ?`)
    .all(...params, proSeiteSicher, offset);

  const eintraege = rows.map((row) => ({
    zeitpunkt: formatZeitpunkt(row.zeitpunkt, lokaleZeit),
    ereignis: EREIGNIS_LABEL[row.ereignis_typ] || row.ereignis_typ,
    person: personName(db, row.person_id),
    jobId: row.job_id,
    dateiname: row.dateiname,
    kontoBezeichnung: row.konto_bezeichnung,
    kommentar: row.kommentar,
    jobStatus: row.job_status,
  }));

  return { eintraege, gesamtAnzahl, seite: seiteSicher, proSeite: proSeiteSicher };
}
