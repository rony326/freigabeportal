import AdmZip from 'adm-zip';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, readdirSync, readFileSync, lstatSync, openSync, closeSync, fstatSync, constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { createHash } from 'node:crypto';

const REQUIRED_TABLES = ['jobs', 'personen', 'konten', 'sessions', 'admin_config', 'freigaben', 'audit_ereignisse', 'export_nachweise', 'archiv_quittungen'];
const FORMAT_VERSION = 2;
export const BACKUP_LIMITS = Object.freeze({
  archiveBytes: 256 * 1024 * 1024,
  entryBytes: 128 * 1024 * 1024,
  totalBytes: 512 * 1024 * 1024,
  entries: 10000,
  manifestBytes: 4 * 1024 * 1024,
});

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

function checkArchivePath(name, directory = false) {
  const parts = (directory ? name.slice(0, -1) : name).split('/');
  if (typeof name !== 'string' || name.length > 1024 || /[\\\x00-\x1f\x7f:]/.test(name) ||
      parts.some((part) => !part || part === '.' || part === '..' || /[. ]$/.test(part)) ||
      !(name === 'db.sqlite' || name === 'manifest.json' || ['jobs', 'branding'].includes(parts[0]) && (directory || parts.length > 1))) {
    throw new BackupValidationError('Unzulaessiger Pfad im Backup-Archiv.');
  }
}

function validateFileReferences(db, manifest, zip) {
  const roots = manifest.quellpfade;
  if (!roots || !['jobs', 'branding', 'cwd'].every((key) => typeof roots[key] === 'string' && isAbsolute(roots[key]))) {
    throw new BackupValidationError('Quellpfade fehlen im Backup-Manifest.');
  }
  function check(path, root, required, expectedHash = null) {
    if (!path) return;
    const name = relative(roots[root], resolve(roots.cwd, path));
    if (!name || name === '..' || name.startsWith(`..${sep}`) || isAbsolute(name)) {
      throw new BackupValidationError('Datenbank verweist auf eine Datei ausserhalb des gesicherten Verzeichnisses.');
    }
    const entry = zip.getEntry(`${root}/${name.split(sep).join('/')}`);
    if (required && (!entry || entry.isDirectory)) throw new BackupValidationError('Eine aktive Datenbank-Dateireferenz fehlt im Backup.');
    if (entry && expectedHash && sha256(entry.getData()) !== expectedHash) {
      throw new BackupValidationError('Belegdatei stimmt nicht mit dem finalen Datenbank-Hash ueberein.');
    }
  }
  for (const job of db.prepare('SELECT status, pdf_pfad, thumbnail_pfad, gruppe_pdf_pfad, gruppe_abgeholt_am, final_datei_hash, zeitstempel_datei_hash, gruppe_zeitstempel_datei_hash FROM jobs').all()) {
    const active = !['archiviert', 'abgeholt', 'geloescht'].includes(job.status);
    check(job.pdf_pfad, 'jobs', active, job.zeitstempel_datei_hash || job.final_datei_hash);
    check(job.thumbnail_pfad, 'jobs', active);
    check(job.gruppe_pdf_pfad, 'jobs', active && !job.gruppe_abgeholt_am, job.gruppe_zeitstempel_datei_hash);
  }
  const logo = db.prepare("SELECT value FROM admin_config WHERE key = 'branding_logo_pfad'").get();
  if (logo?.value) check(logo.value, 'branding', true);
}

export const BACKUP_DATEINAME_PATTERN = /^backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.zip$/;

export function backupDateiname(date = new Date()) {
  return `backup-${date.toISOString().replace(/[:.]/g, '-')}.zip`;
}

export class BackupValidationError extends Error {}

// Zählt die echten Dateien (keine Verzeichniseinträge) unterhalb eines Präfixes im Archiv.
function zaehleDateiEintraege(zip, praefix) {
  return zip.getEntries().filter((entry) => !entry.isDirectory && entry.entryName.startsWith(praefix)).length;
}

// SQLite-eigener Online-Backup-Mechanismus (funktioniert bei laufendem Betrieb, kein Lock auf der
// Live-Verbindung nötig) -- VACUUM INTO verlangt einen noch nicht existierenden Zielpfad, daher
// ein frisches Tempverzeichnis statt eines festen Dateinamens.
export function buildBackupArchive(db, config) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'freigabeportal-backup-'));
  try {
    const dbSnapshotPfad = join(tmpDir, 'db.sqlite');
    db.prepare('VACUUM INTO ?').run(dbSnapshotPfad);
    const snapshotDb = new DatabaseSync(dbSnapshotPfad);
    try { snapshotDb.exec('PRAGMA secure_delete = ON; DELETE FROM sessions; VACUUM;'); } finally { snapshotDb.close(); }

    const zip = new AdmZip();
    const dateien = [];
    const names = new Set();
    let totalBytes = 0;
    function addFile(path, name) {
      checkArchivePath(name);
      const canonical = name.normalize('NFC').toLowerCase();
      if (names.has(canonical)) throw new BackupValidationError('Doppelter portabler Dateipfad im Backup.');
      names.add(canonical);
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.size > BACKUP_LIMITS.entryBytes || totalBytes + stat.size > BACKUP_LIMITS.totalBytes || dateien.length >= BACKUP_LIMITS.entries - 1) {
        throw new BackupValidationError('Backup enthaelt unzulaessige Dateien oder ueberschreitet die Groessenlimits.');
      }
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      let bytes;
      try {
        const opened = fstatSync(fd);
        if (!opened.isFile() || opened.size !== stat.size || opened.ino !== stat.ino || opened.dev !== stat.dev) {
          throw new BackupValidationError('Datei wurde waehrend der Sicherung ausgetauscht.');
        }
        bytes = readFileSync(fd);
      } finally { closeSync(fd); }
      if (bytes.length !== stat.size) throw new BackupValidationError('Datei wurde waehrend der Sicherung veraendert.');
      totalBytes += bytes.length;
      zip.addFile(name, bytes, '', 0o600);
      dateien.push({ pfad: name, groesse: bytes.length, sha256: sha256(bytes) });
    }
    function addDirectory(path, prefix) {
      const stat = lstatSync(path, { throwIfNoEntry: false });
      if (!stat) return;
      if (!stat.isDirectory()) throw new BackupValidationError('Backup-Verzeichnis darf kein symbolischer Link sein.');
      for (const name of readdirSync(path).sort()) {
        const child = join(path, name);
        const stat = lstatSync(child);
        if (stat.isDirectory()) addDirectory(child, `${prefix}/${name}`);
        else addFile(child, `${prefix}/${name}`);
      }
    }
    addFile(dbSnapshotPfad, 'db.sqlite');
    addDirectory(config.jobsDir, 'jobs');
    addDirectory(config.brandingDir, 'branding');
    zip.addFile(
      'manifest.json',
      Buffer.from(
        JSON.stringify(
          {
            formatVersion: FORMAT_VERSION,
            erstelltAm: new Date().toISOString(),
            dateiAnzahlJobs: zaehleDateiEintraege(zip, 'jobs/'),
            dateiAnzahlBranding: zaehleDateiEintraege(zip, 'branding/'),
            dateien,
            quellpfade: { jobs: resolve(config.jobsDir), branding: resolve(config.brandingDir), cwd: process.cwd() },
          },
          null,
          2
        )
      )
    );
    if (zip.getEntry('manifest.json').header.size > BACKUP_LIMITS.manifestBytes) throw new BackupValidationError('Backup-Manifest ist zu gross.');
    const manifest = JSON.parse(zip.readAsText('manifest.json'));
    const referenceDb = new DatabaseSync(dbSnapshotPfad, { readOnly: true });
    try { validateFileReferences(referenceDb, manifest, zip); } finally { referenceDb.close(); }
    const buffer = zip.toBuffer();
    if (buffer.length > BACKUP_LIMITS.archiveBytes) throw new BackupValidationError('Backup-Archiv ist zu gross.');
    return buffer;
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// Validates untrusted archive structure/content before offline staging writes any data.
// Content hashes are consistency checks, not an independent proof of archive origin.
export function validateBackupArchive(buffer) {
  let zip;
  try {
    if (!Buffer.isBuffer(buffer) || buffer.length > BACKUP_LIMITS.archiveBytes) throw new BackupValidationError('Backup-Archiv ist zu gross oder ungueltig.');
    zip = new AdmZip(buffer);
    if (zip.getEntryCount() > BACKUP_LIMITS.entries) throw new BackupValidationError('Zu viele Eintraege im Backup-Archiv.');
    const names = new Map();
    let totalBytes = 0;
    for (const entry of zip.getEntries()) {
      checkArchivePath(entry.entryName, entry.isDirectory);
      const canonical = entry.entryName.replace(/\/$/, '').normalize('NFC').toLowerCase();
      if (names.has(canonical)) throw new BackupValidationError('Doppelter Pfad im Backup-Archiv.');
      names.set(canonical, entry.isDirectory);
      const mode = (entry.attr >>> 16) & 0xf000;
      if (mode && mode !== (entry.isDirectory ? 0x4000 : 0x8000)) throw new BackupValidationError('Links und Spezialdateien sind im Backup nicht erlaubt.');
      const size = entry.header.size;
      totalBytes += size;
      if (!Number.isSafeInteger(size) || size < 0 || size > BACKUP_LIMITS.entryBytes ||
          totalBytes > BACKUP_LIMITS.totalBytes || entry.isDirectory && size !== 0 ||
          entry.entryName === 'manifest.json' && size > BACKUP_LIMITS.manifestBytes) {
        throw new BackupValidationError('Entpackgroesse ueberschreitet die Backup-Limits.');
      }
    }
    for (const name of names.keys()) {
      const parts = name.split('/');
      for (let i = 1; i < parts.length; i += 1) {
        if (names.get(parts.slice(0, i).join('/')) === false) throw new BackupValidationError('Datei kollidiert mit einem Verzeichnispfad im Backup.');
      }
    }
  } catch (err) {
    if (err instanceof BackupValidationError) throw err;
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
  // JSON.parse('null') bzw. '"text"' wirft nicht -- ab hier wird auf Feldern gelesen, deshalb der
  // explizite Objekt-Check statt eines TypeErrors, der als 500 durchschlagen würde.
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new BackupValidationError('manifest.json enthält kein Objekt.');
  }

  // Harte Grenze: ein Archiv aus einer neueren Portal-Version kann Strukturen enthalten, die diese
  // Version beim Restore stillschweigend falsch behandeln würde.
  if (manifest.formatVersion !== FORMAT_VERSION) {
    throw new BackupValidationError(
      'Nur Backup-Format 2 mit Dateimanifest wird akzeptiert. Alte oder unbekannte Formate benoetigen einen gesonderten Migrationsprozess.'
    );
  }

  if (typeof manifest.erstelltAm !== 'string' || !Number.isFinite(Date.parse(manifest.erstelltAm)) || !Array.isArray(manifest.dateien)) {
    throw new BackupValidationError('Backup-Manifest ist unvollstaendig.');
  }
  for (const [praefix, feld] of [
    ['jobs/', 'dateiAnzahlJobs'],
    ['branding/', 'dateiAnzahlBranding'],
  ]) {
    const deklariert = manifest[feld];
    const tatsaechlich = zaehleDateiEintraege(zip, praefix);
    if (!Number.isSafeInteger(deklariert) || deklariert !== tatsaechlich) throw new BackupValidationError('Dateianzahl stimmt nicht mit dem Manifest ueberein.');
  }

  const declared = new Set();
  for (const file of manifest.dateien) {
    if (!file || typeof file.pfad !== 'string' || file.pfad === 'manifest.json' || declared.has(file.pfad) ||
        !Number.isSafeInteger(file.groesse) || file.groesse < 0 || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)) {
      throw new BackupValidationError('Ungueltiger Dateinachweis im Backup-Manifest.');
    }
    declared.add(file.pfad);
    const entry = zip.getEntry(file.pfad);
    if (!entry || entry.isDirectory || entry.header.size !== file.groesse) throw new BackupValidationError('Manifestdatei fehlt oder hat eine andere Groesse.');
    try {
      const bytes = entry.getData();
      if (bytes.length !== file.groesse || sha256(bytes) !== file.sha256) throw new Error('Hash mismatch');
    } catch { throw new BackupValidationError('Backup-Datei ist beschaedigt oder stimmt nicht mit ihrem SHA-256 ueberein.'); }
  }
  if (zip.getEntries().some((entry) => !entry.isDirectory && entry.entryName !== 'manifest.json' && !declared.has(entry.entryName))) {
    throw new BackupValidationError('Archiv enthaelt Dateien ausserhalb des Manifests.');
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
      testDb = new DatabaseSync(tmpDbPfad, { readOnly: true });
      testDb.exec('PRAGMA trusted_schema = OFF');
      const integrity = testDb.prepare('PRAGMA integrity_check').all();
      if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok' || testDb.prepare('PRAGMA foreign_key_check').all().length) {
        throw new BackupValidationError('Datenbankintegritaet oder Fremdschluesselpruefung fehlgeschlagen.');
      }
      const tables = new Set(testDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
      for (const required of REQUIRED_TABLES) {
        if (!tables.has(required)) {
          throw new BackupValidationError(`db.sqlite im Archiv hat keine Tabelle "${required}" — kein gültiges Freigabeportal-Backup.`);
        }
      }
      validateFileReferences(testDb, manifest, zip);
      if (testDb.prepare('SELECT 1 FROM sessions LIMIT 1').get()) {
        throw new BackupValidationError('Backup enthaelt aktive Sessions.');
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

// Retained as an explicit failure for callers of the unsafe legacy service API.
export function restoreBackupArchive() {
  throw new Error('Live-Restore ist gesperrt. Den Offline-Wartungsprozess backup:restore verwenden.');
}
