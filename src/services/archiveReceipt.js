import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { getJobById, listSplitKinder, confirmAbholung, confirmGruppenAbholung } from '../db/jobsRepo.js';
import { getConfigValue } from '../db/adminConfigRepo.js';
import { jobDocument } from './jobDocument.js';

export const ARCHIVE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export class ArchiveError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function loadExportable(db, id) {
  const job = getJobById(db, id);
  if (!job) throw new ArchiveError(404, 'Job nicht gefunden.');
  if (job.aufgesplittet_von || !['abgeschlossen', 'abgeholt', 'aufgesplittet', 'archiviert'].includes(job.status)) {
    throw new ArchiveError(409, 'Job ist nicht fuer den Archivexport freigegeben.');
  }
  const group = job.status === 'aufgesplittet';
  const children = group ? listSplitKinder(db, id).filter((child) => child.status !== 'geloescht') : [];
  if (group && (!job.gruppe_pdf_pfad || !children.length || children.some((child) => !['abgeschlossen', 'abgeholt', 'archiviert'].includes(child.status)))) {
    throw new ArchiveError(409, 'Splitgruppe ist nicht vollstaendig freigegeben.');
  }
  const requiresTimestamp = Boolean(getConfigValue(db, 'zeitstempel_tsa_url')) || job.zeitstempel_erforderlich || children.some((child) => child.zeitstempel_erforderlich);
  if (requiresTimestamp && !(group ? job.gruppe_zeitstempel_gesetzt_am : job.zeitstempel_gesetzt_am)) {
    throw new ArchiveError(409, 'Zeitstempel steht noch aus.');
  }
  return { job, children, group };
}

function documentHash(job) {
  const document = jobDocument(job);
  let bytes;
  try { bytes = readFileSync(document.pdf_pfad); }
  catch { throw new ArchiveError(409, 'Exportdatei fehlt oder ist nicht lesbar.'); }
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (document.zeitstempel_datei_hash && hash !== document.zeitstempel_datei_hash) {
    throw new ArchiveError(409, 'Exportdatei stimmt nicht mit dem gespeicherten Hash ueberein.');
  }
  return hash;
}

function metadata(job) {
  const snapshot = job.freigabe_snapshot ? JSON.parse(job.freigabe_snapshot) : null;
  const approved = snapshot?.job || job;
  return {
    job_id: job.id, nachweis_status: snapshot ? 'snapshot' : 'historisch_unvollstaendig',
    datei_sha256: job.zeitstempel_datei_hash || job.final_datei_hash || null,
    quelle: approved.quelle, eingang_am: approved.eingang_am, absender: approved.absender,
    dateiname: approved.dateiname, lieferant: approved.lieferant, rechnungsnummer: approved.rechnungsnummer,
    betrag: approved.betrag, zahlungsziel: approved.zahlungsziel, rechnungsdatum: approved.rechnungsdatum || null,
    konto_id: approved.konto_id, position: approved.rechnungsposition,
    eingereicht_von: approved.eingereicht_von, auslage_datum: approved.auslage_datum, beschreibung: approved.beschreibung,
    qr_iban: approved.qr_iban, qr_referenz: approved.qr_referenz, qr_betrag: approved.qr_betrag,
    qr_waehrung: approved.qr_waehrung, qr_creditor_name: approved.qr_creditor_name,
    konto_kontonummer: snapshot?.konto?.kontonummer ?? null,
    konto_bezeichnung: snapshot?.konto?.bezeichnung ?? null,
    iban: snapshot?.zahlungsdaten?.iban ?? null, kontoinhaber: snapshot?.zahlungsdaten?.kontoinhaber ?? null,
  };
}

export function createExportEvidence(db, id) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const existing = db.prepare('SELECT * FROM export_nachweise WHERE job_id = ?').get(id);
    // Once receipted, the immutable manifest remains retrievable after local retention ends.
    const receipted = existing && db.prepare('SELECT 1 FROM archiv_quittungen WHERE export_id = ?').get(existing.id);
    if (receipted) {
      db.exec('COMMIT');
      return JSON.parse(existing.manifest);
    }
    const { job, children, group } = loadExportable(db, id);
    const hash = documentHash(job);
    if (existing && existing.sha256 !== hash) throw new ArchiveError(409, 'Exportversion wurde bereits mit anderen Bytes festgeschrieben.');
    if (existing) {
      db.exec('COMMIT');
      return JSON.parse(existing.manifest);
    }
    const manifest = {
      version: 1, export_id: randomUUID(), job_id: id, sha256: hash,
      erstellt_am: new Date().toISOString(), archiv: 'paperless-ngx',
      metadaten: metadata(job), positionen: group ? children.map(metadata) : [],
    };
    manifest.download_pfad = `/api/n8n/jobs/${id}/exportdatei/${manifest.export_id}`;
    manifest.metadaten.datei_sha256 = hash;
    db.prepare('INSERT INTO export_nachweise (id, job_id, sha256, manifest, erstellt_am) VALUES (?, ?, ?, ?, ?)')
      .run(manifest.export_id, id, hash, JSON.stringify(manifest), manifest.erstellt_am);
    db.exec('COMMIT');
    return manifest;
  } catch (err) { db.exec('ROLLBACK'); throw err; }
}

export function readExportDocument(db, id, exportId) {
  const evidence = db.prepare('SELECT * FROM export_nachweise WHERE job_id = ? AND id = ?').get(id, exportId);
  if (!evidence) throw new ArchiveError(404, 'Exportnachweis nicht gefunden.');
  if (!db.prepare('SELECT 1 FROM archiv_quittungen WHERE export_id = ?').get(exportId)) loadExportable(db, id);
  const job = getJobById(db, id);
  let bytes;
  try { bytes = readFileSync(jobDocument(job).pdf_pfad); }
  catch { throw new ArchiveError(409, 'Die festgeschriebene Exportdatei ist lokal nicht verfuegbar.'); }
  if (createHash('sha256').update(bytes).digest('hex') !== evidence.sha256) {
    throw new ArchiveError(409, 'Exportdatei stimmt nicht mit dem Exportnachweis ueberein.');
  }
  return bytes;
}

export function confirmArchiveReceipt(db, id, body) {
  const { export_id, sha256, dokument_id, task_id } = body || {};
  if (typeof export_id !== 'string' || export_id.length > 64 || typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256) ||
      !Number.isSafeInteger(dokument_id) || dokument_id <= 0 ||
      typeof task_id !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(task_id)) {
    throw new ArchiveError(400, 'Erforderlich: export_id, sha256, positive dokument_id und task_id (UUID).');
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const evidence = db.prepare('SELECT * FROM export_nachweise WHERE id = ? AND job_id = ?').get(export_id, id);
    if (!evidence || evidence.sha256 !== sha256) throw new ArchiveError(409, 'Export-ID oder Dateihash stimmt nicht ueberein.');
    const previous = db.prepare('SELECT * FROM archiv_quittungen WHERE export_id = ?').get(export_id);
    if (previous) {
      if (previous.dokument_id !== String(dokument_id) || previous.task_id !== task_id || previous.sha256 !== sha256) {
        throw new ArchiveError(409, 'Abweichende Archivquittung fuer denselben Export.');
      }
      db.exec('COMMIT');
      return previous;
    }
    if (db.prepare('SELECT 1 FROM archiv_quittungen WHERE dokument_id = ?').get(String(dokument_id))) {
      throw new ArchiveError(409, 'Paperless-Dokument ist bereits einem anderen Export zugeordnet.');
    }
    const { job, group } = loadExportable(db, id);
    if (documentHash(job) !== sha256) throw new ArchiveError(409, 'Lokale Exportdatei wurde veraendert.');
    if (group && !job.gruppe_abgeholt_am) {
      if (!confirmGruppenAbholung(db, id)) throw new ArchiveError(409, 'Gruppe kann nicht bestaetigt werden.');
    } else if (!group && job.status === 'abgeschlossen') {
      if (!confirmAbholung(db, id)) throw new ArchiveError(409, 'Job kann nicht bestaetigt werden.');
    }
    const now = new Date().toISOString();
    db.prepare('INSERT INTO archiv_quittungen (export_id, dokument_id, task_id, sha256, bestaetigt_am) VALUES (?, ?, ?, ?, ?)')
      .run(export_id, String(dokument_id), task_id, sha256, now);
    db.exec('COMMIT');
    return { export_id, dokument_id: String(dokument_id), task_id, sha256, bestaetigt_am: now };
  } catch (err) { db.exec('ROLLBACK'); throw err; }
}

export function hasMatureArchiveReceipt(db, job, now = Date.now()) {
  const receipt = db.prepare(`SELECT q.bestaetigt_am, e.manifest FROM archiv_quittungen q
    JOIN export_nachweise e ON e.id = q.export_id WHERE e.job_id = ?`).get(job.aufgesplittet_von || job.id);
  if (!receipt || !Number.isFinite(Date.parse(receipt.bestaetigt_am)) || Date.parse(receipt.bestaetigt_am) > now - ARCHIVE_RETENTION_MS) return false;
  return !job.aufgesplittet_von || JSON.parse(receipt.manifest).positionen.some((position) => position.job_id === job.id);
}

export function archivedBytesMatch(db, job) {
  const document = jobDocument(job);
  if (!document.pdf_pfad || !existsSync(document.pdf_pfad)) return true;
  const evidence = db.prepare('SELECT sha256, manifest FROM export_nachweise WHERE job_id = ?').get(job.aufgesplittet_von || job.id);
  const expected = job.aufgesplittet_von
    ? (evidence && JSON.parse(evidence.manifest).positionen.find((position) => position.job_id === job.id)?.datei_sha256)
    : evidence?.sha256;
  if (!expected) return false;
  try { return createHash('sha256').update(readFileSync(document.pdf_pfad)).digest('hex') === expected; }
  catch { return false; }
}
