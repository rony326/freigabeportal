import AdmZip from 'adm-zip';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, existsSync, readdirSync, mkdirSync, renameSync, writeFileSync, copyFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../db/index.js';
import { logBackupWiederherstellung } from '../db/backupWiederherstellungenRepo.js';

const REQUIRED_TABLES = ['jobs', 'personen', 'konten'];
const FORMAT_VERSION = 1;

export const BACKUP_DATEINAME_PATTERN = /^backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.zip$/;

export function backupDateiname(date = new Date()) {
  return `backup-${date.toISOString().replace(/[:.]/g, '-')}.zip`;
}

export class BackupValidationError extends Error {}

// SQLite-eigener Online-Backup-Mechanismus (funktioniert bei laufendem Betrieb, kein Lock auf der
// Live-Verbindung nötig) -- VACUUM INTO verlangt einen noch nicht existierenden Zielpfad, daher
// ein frisches Tempverzeichnis statt eines festen Dateinamens.
export function buildBackupArchive(db, config) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'freigabeportal-backup-'));
  try {
    const dbSnapshotPfad = join(tmpDir, 'db.sqlite');
    db.prepare('VACUUM INTO ?').run(dbSnapshotPfad);

    const zip = new AdmZip();
    zip.addLocalFile(dbSnapshotPfad, '', 'db.sqlite');
    if (existsSync(config.jobsDir)) zip.addLocalFolder(config.jobsDir, 'jobs');
    if (existsSync(config.brandingDir)) zip.addLocalFolder(config.brandingDir, 'branding');
    zip.addFile(
      'manifest.json',
      Buffer.from(JSON.stringify({ formatVersion: FORMAT_VERSION, erstelltAm: new Date().toISOString() }, null, 2))
    );
    return zip.toBuffer();
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// Validiert vollständig, BEVOR restoreBackupArchive irgendetwas Live anfasst -- wirft
// BackupValidationError mit einer für Admins verständlichen deutschen Meldung statt eines
// generischen Fehlers.
export function validateBackupArchive(buffer) {
  let zip;
  try {
    zip = new AdmZip(buffer);
  } catch {
    throw new BackupValidationError('Datei ist kein gültiges ZIP-Archiv.');
  }

  const manifestEntry = zip.getEntry('manifest.json');
  if (!manifestEntry) throw new BackupValidationError('Archiv enthält keine manifest.json.');
  let manifest;
  try {
    manifest = JSON.parse(zip.readAsText(manifestEntry));
  } catch {
    throw new BackupValidationError('manifest.json ist kein gültiges JSON.');
  }

  const dbEntry = zip.getEntry('db.sqlite');
  if (!dbEntry) throw new BackupValidationError('Archiv enthält keine db.sqlite.');

  const tmpDir = mkdtempSync(join(tmpdir(), 'freigabeportal-restore-validate-'));
  try {
    zip.extractEntryTo(dbEntry, tmpDir, false, true, false, 'db.sqlite');
    const tmpDbPfad = join(tmpDir, 'db.sqlite');
    let testDb;
    // Der DatabaseSync-Konstruktor liest den Dateikopf NICHT ein und wirft bei Garbage-Bytes nicht
    // -- der Fehler ("file is not a database") kommt erst bei der ersten Query. Öffnen und Abfragen
    // laufen deshalb in einem gemeinsamen try/catch, damit jeder SQLite-Fehler an dieser Stelle als
    // BackupValidationError herauskommt statt als roher Fehler durchzuschlagen (siehe Task 8, das
    // gezielt auf BackupValidationError für die deutsche Admin-Fehlermeldung prüft).
    try {
      testDb = new DatabaseSync(tmpDbPfad);
      const tables = new Set(testDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
      for (const required of REQUIRED_TABLES) {
        if (!tables.has(required)) {
          throw new BackupValidationError(`db.sqlite im Archiv hat keine Tabelle "${required}" — kein gültiges Freigabeportal-Backup.`);
        }
      }
    } catch (err) {
      if (err instanceof BackupValidationError) throw err;
      throw new BackupValidationError('db.sqlite im Archiv lässt sich nicht als SQLite-Datenbank öffnen.');
    } finally {
      testDb?.close();
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  return { zip, manifest };
}

function ersetzeVerzeichnisInhalt(zielVerzeichnis, quellVerzeichnis) {
  mkdirSync(zielVerzeichnis, { recursive: true });
  for (const name of readdirSync(zielVerzeichnis)) {
    rmSync(join(zielVerzeichnis, name), { recursive: true, force: true });
  }
  if (existsSync(quellVerzeichnis)) {
    for (const name of readdirSync(quellVerzeichnis)) {
      cpSync(join(quellVerzeichnis, name), join(zielVerzeichnis, name), { recursive: true });
    }
  }
}

// Kein process.exit(), kein Versuch, die laufende `db`-Verbindung live auszutauschen -- siehe
// Design-Spec (docs/superpowers/specs/2026-08-24-datenbank-backup-design.md, Abschnitt "Kontext").
// `db` wird hier nur für den Sicherheits-Snapshot (VACUUM INTO vom noch unveränderten Live-Stand)
// gebraucht.
export function restoreBackupArchive(buffer, db, config, { wiederhergestelltVon, quellDateiname }) {
  const { zip } = validateBackupArchive(buffer);

  const sicherheitsSnapshot = buildBackupArchive(db, config);
  mkdirSync(config.backupDir, { recursive: true });
  const sicherheitsDateiname = backupDateiname(new Date());
  writeFileSync(join(config.backupDir, sicherheitsDateiname), sicherheitsSnapshot);

  const tmpDir = mkdtempSync(join(tmpdir(), 'freigabeportal-restore-'));
  try {
    zip.extractAllTo(tmpDir, true);

    // Neue DB-Datei komplett schreiben, dann atomar per renameSync an DB_PATH -- niemals in-place
    // über die von der laufenden DatabaseSync-Verbindung offen gehaltene Datei schreiben.
    const dbTmpPfad = `${config.dbPath}.restore-${randomUUID()}.tmp`;
    copyFileSync(join(tmpDir, 'db.sqlite'), dbTmpPfad);
    renameSync(dbTmpPfad, config.dbPath);

    ersetzeVerzeichnisInhalt(config.jobsDir, join(tmpDir, 'jobs'));
    ersetzeVerzeichnisInhalt(config.brandingDir, join(tmpDir, 'branding'));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  // `db` (die lang laufende Verbindung des aufrufenden Prozesses) zeigt weiterhin auf die alte
  // Datei -- renameSync tauscht nur den Verzeichniseintrag, das offene File-Handle bleibt am alten
  // Inode. Ein Log-Eintrag über `db` würde also in eine Datei geschrieben, die beim nächsten
  // Prozess-Neustart verworfen wird, sobald die gerade wiederhergestellte Datei übernommen wird.
  // Eine frische, kurzlebige Verbindung direkt auf die neue Datei ist der einzige Weg, wie dieser
  // Audit-Eintrag den Neustart übersteht.
  //
  // openDatabase() statt `new DatabaseSync(config.dbPath)`: Der Datei-Swap ist an dieser Stelle
  // bereits vollständig und korrekt abgeschlossen -- nur der Audit-Log-Insert steht noch aus. Ein
  // wiederhergestelltes Archiv kann älter sein als das aktuelle Schema (z.B. von vor Task 2, ohne
  // die Tabelle backup_wiederherstellungen). openDatabase() fährt schema.sql + Migrationen, bevor
  // die Verbindung zurückgegeben wird, genau wie jeder andere Einstiegspunkt in dieser Codebase --
  // damit existiert die Tabelle garantiert, statt dass ein "no such table"-Fehler hier den
  // eigentlich erfolgreichen Restore fälschlich als fehlgeschlagen erscheinen lässt.
  const restoredDb = openDatabase(config.dbPath);
  try {
    logBackupWiederherstellung(restoredDb, { dateiname: quellDateiname, wiederhergestelltVon });
  } finally {
    restoredDb.close();
  }

  return { sicherheitsSnapshotDateiname: sicherheitsDateiname };
}
