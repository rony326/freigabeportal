import { getKontoById } from './kontenRepo.js';
import { listZuweisungsregeln } from './zuweisungsregelnRepo.js';

function extractDomain(email) {
  const at = email.lastIndexOf('@');
  return at === -1 ? null : email.slice(at + 1).toLowerCase();
}

export function findMatchingZuweisungsregel(db, absender) {
  if (!absender) return null;
  const absenderLower = absender.toLowerCase();
  const domain = extractDomain(absenderLower);
  const regeln = listZuweisungsregeln(db);

  const exactMatch = regeln.find((r) => r.absender_muster.toLowerCase() === absenderLower);
  if (exactMatch) return exactMatch;

  if (domain) {
    const domainMatch = regeln.find((r) => {
      const muster = r.absender_muster.toLowerCase();
      if (muster.includes('@')) return false;
      return domain === muster || domain.endsWith(`.${muster}`);
    });
    if (domainMatch) return domainMatch;
  }

  return null;
}

export function createJob(db, { eingangAm, quelle, absender, dateiname, pdfPfad }) {
  const regel = findMatchingZuweisungsregel(db, absender);
  let kontoId = null;
  let zugewiesenAn = null;
  let status = 'unzugewiesen';

  if (regel) {
    const konto = getKontoById(db, regel.konto_id);
    if (konto && konto.aktiv) {
      kontoId = konto.id;
      zugewiesenAn = konto.freigeber1_id;
      status = 'zugewiesen';
    }
  }

  const result = db
    .prepare(
      `INSERT INTO jobs (eingang_am, quelle, absender, dateiname, pdf_pfad, status, konto_id, zugewiesen_an)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(eingangAm, quelle, absender ?? null, dateiname, pdfPfad, status, kontoId, zugewiesenAn);

  return Number(result.lastInsertRowid);
}

export function getJobById(db, id) {
  return db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) ?? null;
}

export function listPoolJobs(db) {
  return db.prepare("SELECT * FROM jobs WHERE status = 'unzugewiesen' ORDER BY eingang_am").all();
}

export function claimJob(db, id, personId) {
  const result = db
    .prepare("UPDATE jobs SET status = 'zugewiesen', zugewiesen_an = ? WHERE id = ? AND status = 'unzugewiesen'")
    .run(personId, id);
  return result.changes > 0;
}

// listAbholbereitJobs runs entirely synchronously (node:sqlite has no async I/O), so the
// SELECT and the per-row claim UPDATE below cannot interleave with any other request in this
// single Node process — safe without an explicit transaction. This would need one under a
// multi-process deployment.
export function listAbholbereitJobs(db, staleAfterMs = 15 * 60 * 1000) {
  const staleThreshold = new Date(Date.now() - staleAfterMs).toISOString();
  const rows = db
    .prepare(
      `SELECT * FROM jobs WHERE status = 'abgeschlossen'
       AND (fetched_by_n8n_at IS NULL OR fetched_by_n8n_at < ?)`
    )
    .all(staleThreshold);

  const now = new Date().toISOString();
  for (const row of rows) {
    db.prepare('UPDATE jobs SET fetched_by_n8n_at = ? WHERE id = ?').run(now, row.id);
    row.fetched_by_n8n_at = now;
  }
  return rows;
}

export function confirmAbholung(db, id) {
  const job = getJobById(db, id);
  if (!job || job.status !== 'abgeschlossen') {
    return null;
  }
  db.prepare("UPDATE jobs SET status = 'abgeholt' WHERE id = ?").run(id);
  return { ...job, status: 'abgeholt' };
}
