// Archivexport an n8n/Paperless (docs/n8n-paperless-archivierung.md): Exportmanifest, hashgebundener Download der Exportdatei
// und die Archivquittung. Ablauf: n8n holt das Manifest (`createExportEvidence`), lädt die Datei (`readExportDocument`),
// legt sie in Paperless ab und quittiert mit Dokument-ID (`confirmArchiveReceipt`). Erst die Quittung setzt den Vorgang
// auf 'abgeholt'; lokale Dateien bleiben danach noch ARCHIVE_RETENTION_MS erhalten. Alle Fehler tragen einen HTTP-Status.

import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { getJobById, listSplitKinder, confirmAbholung, confirmGruppenAbholung } from '../db/jobsRepo.js';
import { getConfigValue } from '../db/adminConfigRepo.js';
import { jobDocument } from './jobDocument.js';
import { exportNachweis } from './exportSnapshot.js';
import { rapportMetadaten } from './rapporte.js';

// Aufbewahrung der lokalen Datei nach der Archivquittung (7 Tage), bevor die PDF-Bereinigung sie löschen darf.
export const ARCHIVE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

// Fehler mit HTTP-Status (404 unbekannt, 409 Zustand/Hash passt nicht, 400 Eingabe).
export class ArchiveError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// art trennt die beiden Exportwege strikt: Rechnungen (art 'beleg') nur über /api/n8n/jobs,
// Rapporte (art 'rapport') nur über /api/n8n/rapporte. Ein Rapport im Rechnungsweg würde vom
// n8n-Ablauf als Rechnung in Bexio gebucht; er gilt dort darum als nicht vorhanden.
function loadJobOfArt(db, id, art) {
  const job = getJobById(db, id);
  if (!job || (job.typ === 'rapport') !== (art === 'rapport')) throw new ArchiveError(404, 'Job nicht gefunden.');
  return job;
}

// Basispfad der n8n-Schnittstelle je Art (für den `download_pfad` im Manifest).
function exportPfad(art) {
  return art === 'rapport' ? '/api/n8n/rapporte' : '/api/n8n/jobs';
}

// Lädt den Vorgang und prüft, dass er exportiert werden darf (Status, bei Splitgruppen alle Teile fertig, Zeitstempel
// vorhanden, wo verlangt). @returns {{job, children, group}}
function loadExportable(db, id, art) {
  const job = loadJobOfArt(db, id, art);
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

// SHA-256 der Exportdatei; bricht ab, wenn sie fehlt oder nicht zum beim Stempeln gespeicherten Hash passt.
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

// Manifest-Metadaten stammen ausschliesslich aus dem Export-/Zahlungsnachweis (Snapshot oder
// Altfall-Entscheidung). Unbelegte Werte eines bereits uebergebenen Altfalls stehen getrennt
// unter unbelegte_jobdaten und sind nie Teil der freigabegebundenen Metadaten.
function manifestInhalt(db, job, children, group, art) {
  if (art === 'rapport') return { nachweis_status: 'kenntnisnahme', metadaten: rapportMetadaten(db, job), zahlung: null, positionen: [] };
  const nachweis = exportNachweis(db, job);
  if (!nachweis.exportierbar) throw new ArchiveError(409, `Nachpruefung erforderlich: ${nachweis.grund}`);
  const positionen = group
    ? (nachweis.positionen || []).map(({ freigeber1, freigeber2, verlauf, kkHinweis, ...position }) => {
      const child = children.find((c) => c.id === position.job_id);
      return { ...position, datei_sha256: position.datei_sha256 ?? (child ? child.zeitstempel_datei_hash || child.final_datei_hash || null : null) };
    })
    : [];
  return {
    nachweis_status: nachweis.status,
    ...(nachweis.archiv_ohne_zahlung ? { archiv_ohne_zahlung: true } : {}),
    metadaten: { job_id: job.id, nachweis_status: nachweis.status, ...(nachweis.metadaten || {}) },
    ...(nachweis.unbelegte_jobdaten ? { unbelegte_jobdaten: nachweis.unbelegte_jobdaten } : {}),
    zahlung: nachweis.zahlung,
    ...(nachweis.altfall ? { altfall: nachweis.altfall } : {}),
    positionen,
  };
}

/**
 * Erzeugt (idempotent) das unveränderliche Exportmanifest eines Vorgangs und gibt es zurück. Bei erneutem Aufruf kommt
 * dasselbe Manifest, solange die Datei unverändert ist.
 * @param {number} id Vorgang
 * @param {{art?: 'beleg'|'rapport'}} [opts]
 * @throws {ArchiveError} 404/409, z. B. Zeitstempel fehlt, Nachweis unvollständig, Datei verändert
 */
export function createExportEvidence(db, id, { art = 'beleg' } = {}) {
  db.exec('BEGIN IMMEDIATE');
  try {
    loadJobOfArt(db, id, art);
    const existing = db.prepare('SELECT * FROM export_nachweise WHERE job_id = ?').get(id);
    // Nach der Quittung bleibt das unveränderliche Manifest auch nach Ende der lokalen Aufbewahrung abrufbar.
    const receipted = existing && db.prepare('SELECT 1 FROM archiv_quittungen WHERE export_id = ?').get(existing.id);
    if (receipted) {
      db.exec('COMMIT');
      return JSON.parse(existing.manifest);
    }
    const { job, children, group } = loadExportable(db, id, art);
    const hash = documentHash(job);
    if (existing && existing.sha256 !== hash) throw new ArchiveError(409, 'Exportversion wurde bereits mit anderen Bytes festgeschrieben.');
    if (existing) {
      db.exec('COMMIT');
      return JSON.parse(existing.manifest);
    }
    const manifest = {
      version: 2, export_id: randomUUID(), job_id: id, sha256: hash,
      erstellt_am: new Date().toISOString(), archiv: 'paperless-ngx',
      ...manifestInhalt(db, job, children, group, art),
    };
    manifest.download_pfad = `${exportPfad(art)}/${id}/exportdatei/${manifest.export_id}`;
    manifest.metadaten.datei_sha256 = hash;
    db.prepare('INSERT INTO export_nachweise (id, job_id, sha256, manifest, erstellt_am) VALUES (?, ?, ?, ?, ?)')
      .run(manifest.export_id, id, hash, JSON.stringify(manifest), manifest.erstellt_am);
    db.exec('COMMIT');
    return manifest;
  } catch (err) { db.exec('ROLLBACK'); throw err; }
}

// Liefert die Exportdatei (Bytes) zum Manifest `exportId` – nur, wenn der Hash noch dem festgeschriebenen entspricht.
export function readExportDocument(db, id, exportId, { art = 'beleg' } = {}) {
  const job = loadJobOfArt(db, id, art);
  const evidence = db.prepare('SELECT * FROM export_nachweise WHERE job_id = ? AND id = ?').get(id, exportId);
  if (!evidence) throw new ArchiveError(404, 'Exportnachweis nicht gefunden.');
  if (!db.prepare('SELECT 1 FROM archiv_quittungen WHERE export_id = ?').get(exportId)) loadExportable(db, id, art);
  let bytes;
  try { bytes = readFileSync(jobDocument(job).pdf_pfad); }
  catch { throw new ArchiveError(409, 'Die festgeschriebene Exportdatei ist lokal nicht verfuegbar.'); }
  if (createHash('sha256').update(bytes).digest('hex') !== evidence.sha256) {
    throw new ArchiveError(409, 'Exportdatei stimmt nicht mit dem Exportnachweis ueberein.');
  }
  return bytes;
}

/**
 * Nimmt die Archivquittung von n8n entgegen (Export-ID, SHA-256, Paperless-Dokument-ID, Aufgaben-UUID), prüft sie gegen
 * Manifest und lokale Datei und stellt den Vorgang auf 'abgeholt'. Idempotent bei identischer Wiederholung, 409 bei Abweichung.
 */
export function confirmArchiveReceipt(db, id, body, { art = 'beleg' } = {}) {
  const { export_id, sha256, dokument_id, task_id } = body || {};
  if (typeof export_id !== 'string' || export_id.length > 64 || typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256) ||
      !Number.isSafeInteger(dokument_id) || dokument_id <= 0 ||
      typeof task_id !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(task_id)) {
    throw new ArchiveError(400, 'Erforderlich: export_id, sha256, positive dokument_id und task_id (UUID).');
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    loadJobOfArt(db, id, art);
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
    const { job, group } = loadExportable(db, id, art);
    if (documentHash(job) !== sha256) throw new ArchiveError(409, 'Lokale Exportdatei wurde veraendert.');
    if (art === 'rapport') {
      // confirmAbholung schliesst Rapporte aus (Rechnungsweg); hier gezielt nur den Rapport umstellen.
      if (job.status === 'abgeschlossen' &&
          db.prepare("UPDATE jobs SET status = 'abgeholt' WHERE id = ? AND typ = 'rapport' AND status = 'abgeschlossen'").run(id).changes === 0) {
        throw new ArchiveError(409, 'Rapport kann nicht bestaetigt werden.');
      }
    } else if (group && !job.gruppe_abgeholt_am) {
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

// true, wenn die Archivquittung älter als die Aufbewahrungsfrist ist (und bei Teilvorgängen im Manifest enthalten) – Voraussetzung fürs Löschen der Datei.
export function hasMatureArchiveReceipt(db, job, now = Date.now()) {
  const receipt = db.prepare(`SELECT q.bestaetigt_am, e.manifest FROM archiv_quittungen q
    JOIN export_nachweise e ON e.id = q.export_id WHERE e.job_id = ?`).get(job.aufgesplittet_von || job.id);
  if (!receipt || !Number.isFinite(Date.parse(receipt.bestaetigt_am)) || Date.parse(receipt.bestaetigt_am) > now - ARCHIVE_RETENTION_MS) return false;
  return !job.aufgesplittet_von || JSON.parse(receipt.manifest).positionen.some((position) => position.job_id === job.id);
}

// Prüft vor dem Löschen, dass die lokale Datei noch genau den archivierten Bytes entspricht (fehlt die Datei, gilt das als ok).
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
