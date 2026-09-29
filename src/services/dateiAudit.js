import { lstatSync, readFileSync, unlinkSync } from 'node:fs';
import { basename } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { currentAuditActor } from './auditContext.js';

const DATEIARTEN = new Set(['beleg_pdf', 'thumbnail', 'gruppen_pdf', 'tmp_datei']);
const FEHLERCODES = new Set(['ENOENT', 'EACCES', 'EPERM', 'EISDIR', 'EBUSY', 'NOT_A_FILE']);

// Sicherheitsrelevante Datei-Loeschung mit Audit-Klammer, analog zu deleteBackupWithAudit:
// 1. 'datei_loeschung_beabsichtigt' (mit SHA-256 und Groesse der noch vorhandenen Datei) wird
//    ausserhalb einer rueckrollbaren Transaktion gespeichert; ohne gespeicherte Absicht kein Eingriff.
// 2. Nach dem Unlink 'datei_geloescht' bzw. bei Dateifehler 'datei_loeschung_fehlgeschlagen'.
// Protokolliert wird nur der generierte Dateiname, nie der absolute Pfad oder Dateiinhalt.
// Rueckgabe: true, wenn die Datei danach nicht mehr existiert.
export function loescheDateiMitAudit(db, pfad, { objekt, objektId, dateiart, anlass }) {
  if (!DATEIARTEN.has(dateiart)) throw new Error('Unbekannte Dateiart fuer protokollierte Loeschung.');
  if (db.isTransaction) throw new Error('Protokollierte Datei-Loeschung darf nicht in einer DB-Transaktion laufen.');
  let stat;
  try { stat = lstatSync(pfad); } catch (err) {
    if (err.code === 'ENOENT') return true;
    throw err;
  }
  const operationId = randomUUID();
  const actor = currentAuditActor();
  const dateiname = basename(pfad);
  const write = (aktion, details) => db.prepare(`INSERT INTO audit_ereignisse
    (zeitpunkt, person_id, person_name, objekt, objekt_id, aktion, nachher, begruendung)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(new Date().toISOString(), actor.id, actor.name, objekt, String(objektId), aktion,
    JSON.stringify({ operationId, dateiname, dateiart, ...details }), anlass);
  const istDatei = stat.isFile();
  write('datei_loeschung_beabsichtigt', istDatei
    ? { sha256: createHash('sha256').update(readFileSync(pfad)).digest('hex'), groesse: stat.size }
    : { sha256: null, groesse: null });
  try {
    if (!istDatei) throw Object.assign(new Error('Keine regulaere Datei.'), { code: 'NOT_A_FILE' });
    unlinkSync(pfad);
  } catch (err) {
    write('datei_loeschung_fehlgeschlagen', { code: FEHLERCODES.has(err.code) ? err.code : 'DELETE_FAILED' });
    return false;
  }
  write('datei_geloescht', {});
  return true;
}
