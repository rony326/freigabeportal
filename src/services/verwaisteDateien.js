import { lstatSync, readdirSync, mkdirSync, linkSync, unlinkSync, openSync, closeSync, fstatSync, readFileSync, fsyncSync, constants } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { currentAuditActor } from './auditContext.js';
import { auditedJob } from './auditOperation.js';
import { loescheDateiMitAudit } from './dateiAudit.js';
import { getConfigValue } from '../db/adminConfigRepo.js';
import { hasRecentRunningCronLauf } from '../db/cronLogRepo.js';

// Erkennung verwaister finaler Dokumente.
//
// Commit-Grenze: Einzelfreigabe (freigabe2.js), Zeitstempel-Nachholen (cronJobs.js) und
// Gruppenfinalisierung (splitGruppenExport.js) schreiben zuerst eine neue Datei final-<uuid>.pdf
// (writeFinalDocument, fsync) und setzen erst danach in einer DB-Transaktion den Dateizeiger. Ein
// Abbruch zwischen beiden Schritten hinterlaesst eine nie referenzierte Datei; ein Abbruch nach dem
// Commit nicht. Der Fehlerpfad loescht nur die eigene Datei, ein SIGKILL/Stromausfall gar nichts.
//
// Diese Bereinigung loescht nie selbst. Sie verschiebt eindeutig verwaiste Dateien nur in ein
// Quarantaeneverzeichnis innerhalb von jobsDir (gleiches Dateisystem, wird mitgesichert). Endgueltig
// geloescht oder zurueckgeholt wird nur durch ausdrueckliche, begruendete Administratorentscheidung.
//
// Nicht verschoben werden: juengere Dateien als das Mindestalter, alles ausser regulaeren Dateien
// (Symlinks, Verzeichnisse), Dateien, deren Name in einer aktiven Tabelle oder im Auditprotokoll
// vorkommt, und Dateien, deren SHA-256 einem gespeicherten finalen/Export-Hash entspricht. Bei
// laufenden Nachhol-Jobs, unklarem Verzeichniszustand oder DB-Fehlern wird nichts verschoben.

export const FINAL_DATEI_MUSTER = /^final-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pdf$/;
export const QUARANTAENE_VERZEICHNIS = 'quarantaene-verwaiste-dateien';
const STANDARD_MINDESTALTER_STUNDEN = 24;
const MIN_MINDESTALTER_STUNDEN = 1;
// Tabellen, deren Textspalten auf Dateinamen durchsucht werden. Konservativ: jede Erwaehnung
// schuetzt die Datei, auch in JSON-Snapshots oder Manifesten.
const REFERENZ_TABELLEN = ['jobs', 'kk_belege', 'export_nachweise', 'archiv_quittungen', 'admin_config'];
const HASH_SPALTEN = { jobs: ['final_datei_hash', 'zeitstempel_datei_hash', 'gruppe_final_datei_hash', 'gruppe_zeitstempel_datei_hash', 'datei_hash'], export_nachweise: ['sha256'], archiv_quittungen: ['sha256'] };

export class QuarantaeneFehler extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

function mindestAlterMs(db, override) {
  if (override !== undefined) return override;
  const stunden = Number(getConfigValue(db, 'verwaiste_dateien_mindestalter_stunden') ?? STANDARD_MINDESTALTER_STUNDEN);
  return Math.max(MIN_MINDESTALTER_STUNDEN, Number.isFinite(stunden) ? stunden : STANDARD_MINDESTALTER_STUNDEN) * 60 * 60 * 1000;
}

function echtesVerzeichnis(pfad) {
  const stat = lstatSync(pfad, { throwIfNoEntry: false });
  if (!stat || !stat.isDirectory()) throw new QuarantaeneFehler('Verzeichnis fehlt oder ist kein echtes Verzeichnis (Symlink?).', 409);
  return stat;
}

function quarantaeneVerzeichnis(jobsDir, anlegen) {
  const pfad = join(jobsDir, QUARANTAENE_VERZEICHNIS);
  if (anlegen && !lstatSync(pfad, { throwIfNoEntry: false })) mkdirSync(pfad, { mode: 0o700 });
  echtesVerzeichnis(pfad);
  return pfad;
}

function syncVerzeichnis(pfad) {
  const fd = openSync(pfad, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

// Liest eine regulaere Datei ohne Symlink-Folge und liefert Inode-Daten plus SHA-256.
function dateiFingerabdruck(pfad) {
  const fd = openSync(pfad, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new QuarantaeneFehler('Keine regulaere Datei.', 409);
    return { ino: stat.ino, dev: stat.dev, groesse: stat.size, mtimeMs: stat.mtimeMs, sha256: createHash('sha256').update(readFileSync(fd)).digest('hex') };
  } finally { closeSync(fd); }
}

function textSpalten(db, tabelle) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(tabelle)) return [];
  return db.prepare(`PRAGMA table_info(${tabelle})`).all()
    .filter((spalte) => !spalte.type || /TEXT|CHAR|CLOB/i.test(spalte.type)).map((spalte) => spalte.name);
}

export function dateinameReferenziert(db, dateiname) {
  for (const tabelle of REFERENZ_TABELLEN) {
    const spalten = textSpalten(db, tabelle);
    if (!spalten.length) continue;
    const where = spalten.map((spalte) => `instr("${spalte}", ?) > 0`).join(' OR ');
    if (db.prepare(`SELECT 1 FROM ${tabelle} WHERE ${where} LIMIT 1`).get(...spalten.map(() => dateiname))) return 'aktiv';
  }
  if (db.prepare('SELECT 1 FROM audit_ereignisse WHERE instr(vorher, ?) > 0 OR instr(nachher, ?) > 0 LIMIT 1').get(dateiname, dateiname)) return 'historisch';
  return null;
}

export function hashBekannt(db, sha256) {
  for (const [tabelle, spalten] of Object.entries(HASH_SPALTEN)) {
    const vorhandene = new Set(textSpalten(db, tabelle));
    const nutzbar = spalten.filter((spalte) => vorhandene.has(spalte));
    if (!nutzbar.length) continue;
    if (db.prepare(`SELECT 1 FROM ${tabelle} WHERE ${nutzbar.map((s) => `"${s}" = ?`).join(' OR ')} LIMIT 1`).get(...nutzbar.map(() => sha256))) return true;
  }
  return false;
}

function schreibeAudit(db, aktion, objektId, nachher, begruendung = null) {
  const actor = currentAuditActor();
  db.prepare(`INSERT INTO audit_ereignisse (zeitpunkt, person_id, person_name, objekt, objekt_id, aktion, nachher, begruendung)
    VALUES (?, ?, ?, 'datei_quarantaene', ?, ?, ?, ?)`).run(new Date().toISOString(), actor.id, actor.name, String(objektId), aktion, JSON.stringify(nachher), begruendung);
}

// Nicht ueberschreibendes Verschieben innerhalb desselben Dateisystems: link() schlaegt fehl,
// wenn das Ziel existiert, und folgt auf Linux keinem Symlink in der Quelle.
function verschiebeOhneUeberschreiben(quelle, ziel) {
  linkSync(quelle, ziel);
  unlinkSync(quelle);
}

function laufendeNachholjobs(db) {
  return ['zeitstempel-nachholen', 'split-gruppen-nachholen'].some((job) => hasRecentRunningCronLauf(db, job));
}

export function pruefeVerwaisteFinaleDateien(db, config, { mindestAlterMs: mindestAlterOverride, jetzt = Date.now(), vorTransaktion } = {}) {
  if (db.isTransaction) throw new Error('Verwaiste-Dateien-Pruefung braucht eine eigene Transaktion.');
  const ergebnis = { status: 'erfolg', geprueft: 0, verschoben: 0, referenziert: 0, historisch: 0, hashBekannt: 0, zuJung: 0, keineRegulaereDatei: 0, fehler: 0 };
  if (laufendeNachholjobs(db)) return { ...ergebnis, status: 'uebersprungen', grund: 'nachholjob_aktiv' };
  const jobsDir = config.jobsDir;
  if (!jobsDir || !lstatSync(jobsDir, { throwIfNoEntry: false })) return { ...ergebnis, status: 'uebersprungen', grund: 'kein_verzeichnis' };
  const verzeichnisStat = echtesVerzeichnis(jobsDir);
  const quarantaene = quarantaeneVerzeichnis(jobsDir, true);
  const grenze = jetzt - mindestAlterMs(db, mindestAlterOverride);

  for (const name of readdirSync(jobsDir).sort()) {
    if (!FINAL_DATEI_MUSTER.test(name)) continue;
    ergebnis.geprueft += 1;
    const pfad = join(jobsDir, name);
    const stat = lstatSync(pfad, { throwIfNoEntry: false });
    if (!stat) continue;
    if (!stat.isFile()) { ergebnis.keineRegulaereDatei += 1; continue; }
    if (stat.mtimeMs > grenze) { ergebnis.zuJung += 1; continue; }
    const ziel = join(quarantaene, name);
    try {
      const vorher = dateiFingerabdruck(pfad);
      vorTransaktion?.(name);
      db.exec('BEGIN IMMEDIATE');
      try {
        // Unter der Schreibsperre erneut pruefen: ein zwischenzeitlicher Commit einer Finalisierung
        // macht die Datei referenziert, und die Datei darf sich nicht veraendert haben.
        const referenz = dateinameReferenziert(db, name);
        if (referenz || hashBekannt(db, vorher.sha256)) {
          db.exec('ROLLBACK');
          if (referenz === 'aktiv') ergebnis.referenziert += 1;
          else if (referenz === 'historisch') ergebnis.historisch += 1;
          else ergebnis.hashBekannt += 1;
          continue;
        }
        const jetztStat = lstatSync(pfad, { throwIfNoEntry: false });
        if (!jetztStat?.isFile() || jetztStat.ino !== vorher.ino || jetztStat.dev !== verzeichnisStat.dev || jetztStat.size !== vorher.groesse || jetztStat.mtimeMs !== vorher.mtimeMs) {
          throw new QuarantaeneFehler('Datei wurde waehrend der Pruefung veraendert.', 409);
        }
        const bestehend = lstatSync(ziel, { throwIfNoEntry: false });
        if (bestehend) {
          // Rest eines abgebrochenen frueheren Laufs (link erfolgt, unlink/Commit nicht): nur ein
          // Hardlink auf dieselbe Inode darf entfernt werden, sonst Abbruch ohne Aenderung.
          if (!bestehend.isFile() || bestehend.ino !== vorher.ino || bestehend.dev !== vorher.dev) throw new QuarantaeneFehler('Quarantaene-Ziel existiert bereits.', 409);
          unlinkSync(ziel);
        }
        const id = Number(db.prepare(`INSERT INTO datei_quarantaene (dateiname, sha256, groesse, datei_geaendert_am, verschoben_am)
          VALUES (?, ?, ?, ?, ?)`).run(name, vorher.sha256, vorher.groesse, new Date(vorher.mtimeMs).toISOString(), new Date().toISOString()).lastInsertRowid);
        schreibeAudit(db, 'verwaiste_datei_in_quarantaene', id, { dateiname: name, sha256: vorher.sha256, groesse: vorher.groesse });
        verschiebeOhneUeberschreiben(pfad, ziel);
        try {
          syncVerzeichnis(quarantaene);
          syncVerzeichnis(jobsDir);
          db.exec('COMMIT');
        } catch (err) {
          // Ohne Commit gibt es keinen Nachweis: Datei an den Ursprungsort zurueck.
          if (db.isTransaction) db.exec('ROLLBACK');
          verschiebeOhneUeberschreiben(ziel, pfad);
          throw err;
        }
        ergebnis.verschoben += 1;
      } catch (err) {
        if (db.isTransaction) db.exec('ROLLBACK');
        throw err;
      }
    } catch (err) {
      ergebnis.fehler += 1;
      console.error(`Pruefung verwaister Datei ${name} ohne Aenderung abgebrochen:`, err.code || err.message);
    }
  }
  return ergebnis;
}

export const runVerwaisteDateienPruefung = auditedJob('verwaiste-dateien', (db, config, options) => {
  try {
    return pruefeVerwaisteFinaleDateien(db, config, options);
  } catch (err) {
    console.error('Pruefung verwaister Dateien fehlgeschlagen:', err.message);
    return { status: 'fehler', error: err.message };
  }
});

function pruefeBegruendung(begruendung) {
  if (typeof begruendung !== 'string' || begruendung.trim().length < 10 || begruendung.length > 2000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(begruendung)) {
    throw new QuarantaeneFehler('Begruendung (10 bis 2000 Zeichen) ist erforderlich.', 400);
  }
  return begruendung.trim();
}

function offenerEintrag(db, id) {
  if (!Number.isSafeInteger(id) || id < 1) throw new QuarantaeneFehler('Ungueltiger Quarantaene-Eintrag.', 400);
  const eintrag = db.prepare("SELECT * FROM datei_quarantaene WHERE id = ? AND status = 'quarantaene'").get(id);
  if (!eintrag) throw new QuarantaeneFehler('Eintrag fehlt oder wurde bereits entschieden.', 409);
  return eintrag;
}

function entscheide(db, id, status, begruendung) {
  const actor = currentAuditActor();
  db.prepare("UPDATE datei_quarantaene SET status = ?, entschieden_von = ?, entschieden_am = ?, begruendung = ? WHERE id = ? AND status = 'quarantaene'")
    .run(status, actor.id, new Date().toISOString(), begruendung, id);
}

export function listQuarantaene(db, { limit = 100 } = {}) {
  return db.prepare("SELECT * FROM datei_quarantaene ORDER BY status = 'quarantaene' DESC, id DESC LIMIT ?").all(Math.min(Math.max(1, limit), 500));
}

export function stelleQuarantaeneDateiWiederHer(db, config, id, begruendungRoh) {
  const begruendung = pruefeBegruendung(begruendungRoh);
  if (db.isTransaction) throw new Error('Quarantaene-Entscheidung braucht eine eigene Transaktion.');
  echtesVerzeichnis(config.jobsDir);
  const quarantaene = quarantaeneVerzeichnis(config.jobsDir, false);
  db.exec('BEGIN IMMEDIATE');
  let verschoben = null;
  try {
    const eintrag = offenerEintrag(db, id);
    const quelle = join(quarantaene, eintrag.dateiname);
    const ziel = join(config.jobsDir, eintrag.dateiname);
    if (dateiFingerabdruck(quelle).sha256 !== eintrag.sha256) throw new QuarantaeneFehler('Quarantaene-Datei stimmt nicht mehr mit dem gespeicherten Hash ueberein.', 409);
    entscheide(db, id, 'wiederhergestellt', begruendung);
    schreibeAudit(db, 'quarantaene_datei_wiederhergestellt', id, { dateiname: eintrag.dateiname, sha256: eintrag.sha256 }, begruendung);
    verschiebeOhneUeberschreiben(quelle, ziel);
    verschoben = { quelle, ziel };
    syncVerzeichnis(config.jobsDir);
    syncVerzeichnis(quarantaene);
    db.exec('COMMIT');
  } catch (err) {
    if (db.isTransaction) db.exec('ROLLBACK');
    if (verschoben) verschiebeOhneUeberschreiben(verschoben.ziel, verschoben.quelle);
    if (err.code === 'EEXIST') throw new QuarantaeneFehler('Am Ursprungsort existiert bereits eine Datei gleichen Namens.', 409);
    throw err;
  }
}

// Endgueltige Loeschung nur auf ausdrueckliche Entscheidung. Der Dateieingriff selbst laeuft ueber
// die Audit-Klammer (Absicht/Ergebnis); der Status wird erst nach erfolgreichem Unlink gesetzt.
export function loescheQuarantaeneDatei(db, config, id, begruendungRoh) {
  const begruendung = pruefeBegruendung(begruendungRoh);
  if (db.isTransaction) throw new Error('Quarantaene-Entscheidung braucht eine eigene Transaktion.');
  echtesVerzeichnis(config.jobsDir);
  const quarantaene = quarantaeneVerzeichnis(config.jobsDir, false);
  const eintrag = offenerEintrag(db, id);
  const pfad = join(quarantaene, eintrag.dateiname);
  if (!lstatSync(pfad, { throwIfNoEntry: false })) throw new QuarantaeneFehler('Quarantaene-Datei fehlt; Zustand bitte manuell pruefen.', 409);
  if (dateiFingerabdruck(pfad).sha256 !== eintrag.sha256) throw new QuarantaeneFehler('Quarantaene-Datei stimmt nicht mehr mit dem gespeicherten Hash ueberein.', 409);
  if (dateinameReferenziert(db, eintrag.dateiname) === 'aktiv' || hashBekannt(db, eintrag.sha256)) {
    throw new QuarantaeneFehler('Datei wird inzwischen referenziert und darf nicht geloescht werden.', 409);
  }
  if (!loescheDateiMitAudit(db, pfad, { objekt: 'datei_quarantaene', objektId: id, dateiart: 'quarantaene_datei', anlass: begruendung })) {
    throw new QuarantaeneFehler('Datei konnte nicht geloescht werden.', 409);
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    offenerEintrag(db, id);
    entscheide(db, id, 'geloescht', begruendung);
    schreibeAudit(db, 'quarantaene_datei_geloescht', id, { dateiname: eintrag.dateiname, sha256: eintrag.sha256 }, begruendung);
    db.exec('COMMIT');
  } catch (err) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw err;
  }
}
