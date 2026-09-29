import { lstatSync, unlinkSync } from 'node:fs';
import { basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { currentAuditActor } from './auditContext.js';
import { BACKUP_DATEINAME_PATTERN } from './backup.js';

export function deleteBackupWithAudit(db, path, reason) {
  const filename = basename(path);
  if (!BACKUP_DATEINAME_PATTERN.test(filename)) throw new Error('Ungueltiger Backup-Dateiname.');
  if (db.isTransaction) throw new Error('Backup-Loeschung darf nicht in einer DB-Transaktion laufen.');
  if (typeof reason !== 'string' || !reason.trim() || reason.length > 2000) throw new Error('Backup-Loeschgrund fehlt oder ist zu lang.');
  const operationId = randomUUID();
  const actor = currentAuditActor();
  const write = (action, details) => db.prepare(`INSERT INTO audit_ereignisse
    (zeitpunkt, person_id, person_name, objekt, objekt_id, aktion, nachher, begruendung)
    VALUES (?, ?, ?, 'backup', ?, ?, ?, ?)`).run(
    new Date().toISOString(), actor.id, actor.name, filename, action,
    JSON.stringify({ operationId, ...details }), reason.trim());
  // Persist intent before the irreversible filesystem action, outside a rollbackable transaction.
  write('backup_loeschung_beabsichtigt', {});
  try {
    if (!lstatSync(path).isFile()) throw new Error('Backup ist keine regulaere Datei.');
    unlinkSync(path);
  } catch (err) {
    write('backup_loeschung_fehlgeschlagen', { code: ['ENOENT', 'EACCES', 'EPERM', 'EISDIR'].includes(err.code) ? err.code : 'DELETE_FAILED' });
    throw err;
  }
  write('backup_geloescht', {});
}

export function listUnresolvedBackupDeletions(db, { before = Number.MAX_SAFE_INTEGER, limit = 50 } = {}) {
  if (!Number.isSafeInteger(before) || before < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('Ungueltige Seitengrenzen fuer Backup-Loeschabsichten.');
  }
  return db.prepare(`SELECT i.id, i.zeitpunkt, i.person_name, i.objekt_id AS dateiname,
      json_extract(CASE WHEN json_valid(i.nachher) THEN i.nachher ELSE '{}' END, '$.operationId') AS operation_id
    FROM audit_ereignisse i
    WHERE i.objekt = 'backup' AND i.aktion = 'backup_loeschung_beabsichtigt' AND i.id < ?
      AND NOT EXISTS (SELECT 1 FROM audit_ereignisse e
        WHERE e.objekt = 'backup' AND e.objekt_id = i.objekt_id AND e.id > i.id
          AND e.aktion IN ('backup_geloescht', 'backup_loeschung_fehlgeschlagen')
          AND json_extract(CASE WHEN json_valid(e.nachher) THEN e.nachher ELSE '{}' END, '$.operationId') =
              json_extract(CASE WHEN json_valid(i.nachher) THEN i.nachher ELSE '{}' END, '$.operationId'))
      AND NOT EXISTS (SELECT 1 FROM audit_ereignisse e
        WHERE e.objekt = 'backup' AND e.objekt_id = i.objekt_id AND e.id > i.id
          AND e.aktion = 'backup_loeschung_geprueft'
          AND json_extract(CASE WHEN json_valid(e.nachher) THEN e.nachher ELSE '{}' END, '$.intentId') = i.id)
    ORDER BY i.id DESC LIMIT ?`).all(before, limit);
}

export class BackupReviewError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

export function reviewBackupDeletion(db, intentId, observation, reason) {
  if (!Number.isSafeInteger(intentId) || intentId < 1 || intentId >= Number.MAX_SAFE_INTEGER ||
      !['datei_vorhanden', 'datei_nicht_vorhanden'].includes(observation) ||
      typeof reason !== 'string' || reason.trim().length < 10 || reason.length > 2000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(reason)) {
    throw new BackupReviewError('Gueltiger Vorgang, Dateibestand und Begruendung (10 bis 2000 Zeichen) sind erforderlich.', 400);
  }
  if (db.isTransaction) throw new Error('Backup-Pruefung benoetigt eine eigene Transaktion.');
  db.exec('BEGIN IMMEDIATE');
  try {
    const intent = listUnresolvedBackupDeletions(db, { before: intentId + 1, limit: 1 })[0];
    if (intent?.id !== intentId) throw new BackupReviewError('Loeschabsicht fehlt oder wurde bereits abgeschlossen/geprueft.', 409);
    const actor = currentAuditActor();
    const result = db.prepare(`INSERT INTO audit_ereignisse
      (zeitpunkt, person_id, person_name, objekt, objekt_id, aktion, nachher, begruendung)
      VALUES (?, ?, ?, 'backup', ?, 'backup_loeschung_geprueft', ?, ?)`).run(
      new Date().toISOString(), actor.id, actor.name, intent.dateiname,
      JSON.stringify({ intentId, operationId: intent.operation_id, observation, evidence: 'administrator_statement' }), reason.trim());
    db.exec('COMMIT');
    return Number(result.lastInsertRowid);
  } catch (err) { db.exec('ROLLBACK'); throw err; }
}
