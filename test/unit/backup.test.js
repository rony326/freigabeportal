import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import { createHash } from 'node:crypto';
import { restoreOffline } from '../../src/services/offlineRestore.js';
import { openDatabase } from '../../src/db/index.js';
import { seedDefaults } from '../../src/db/adminConfigRepo.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createJob, getJobById } from '../../src/db/jobsRepo.js';
import { listBackupWiederherstellungen } from '../../src/db/backupWiederherstellungenRepo.js';
import {
  buildBackupArchive,
  validateBackupArchive,
  restoreBackupArchive,
  backupDateiname,
  BACKUP_DATEINAME_PATTERN,
  BackupValidationError,
} from '../../src/services/backup.js';

test('backupDateiname produces a filesystem-safe name matching BACKUP_DATEINAME_PATTERN', () => {
  const name = backupDateiname(new Date('2026-08-24T13:05:00.123Z'));
  assert.equal(name, 'backup-2026-08-24T13-05-00-123Z.zip');
  assert.match(name, BACKUP_DATEINAME_PATTERN);
});

test('offline restore roundtrip preserves the previous database and rebases files into a fresh generation', () => {
  const quellDir = mkdtempSync(join(tmpdir(), 'backup-quelle-'));
  const zielDir = mkdtempSync(join(tmpdir(), 'backup-ziel-'));
  const quellConfig = {
    jobsDir: join(quellDir, 'jobs'),
    brandingDir: join(quellDir, 'branding'),
    backupDir: join(quellDir, 'backups'),
    dbPath: join(quellDir, 'quelle.sqlite'),
  };
  const zielConfig = {
    jobsDir: join(zielDir, 'jobs'),
    brandingDir: join(zielDir, 'branding'),
    backupDir: join(zielDir, 'backups'),
    dbPath: join(zielDir, 'ziel.sqlite'),
  };

  mkdirSync(quellConfig.jobsDir, { recursive: true });
  mkdirSync(quellConfig.brandingDir, { recursive: true });
  writeFileSync(join(quellConfig.jobsDir, 'rechnung.pdf'), 'pdf-inhalt');
  writeFileSync(join(quellConfig.brandingDir, 'logo.png'), 'logo-inhalt');

  const quellDb = openDatabase(quellConfig.dbPath);
  seedDefaults(quellDb);
  upsertPerson(quellDb, { id: '1', vorname: 'Test', nachname: 'Person', email: 't@example.org', gruppen: [], loggedInNow: false });
  const jobId = createJob(quellDb, {
    eingangAm: '2026-08-01T00:00:00.000Z',
    quelle: 'scanner',
    absender: null,
    dateiname: 'rechnung.pdf',
    pdfPfad: join(quellConfig.jobsDir, 'rechnung.pdf'),
  });

  const archiv = buildBackupArchive(quellDb, quellConfig);
  quellDb.close();

  const zielDb = openDatabase(zielConfig.dbPath);
  zielDb.close();
  const restored = restoreOffline(archiv, zielConfig, {
    expectedSha256: createHash('sha256').update(archiv).digest('hex'),
    operator: '1', reason: 'Wiederherstellungsprobe', sourceName: 'hochgeladenes-backup.zip',
  });

  const previousDb = openDatabase(zielConfig.dbPath);
  assert.equal(previousDb.prepare('SELECT count(*) AS n FROM jobs').get().n, 0);
  previousDb.close();

  // DB-Inhalt kam vollständig an.
  const wiederhergestellteDb = openDatabase(restored.current.dbPath);
  const wiederhergestellterJob = getJobById(wiederhergestellteDb, jobId);
  assert.equal(wiederhergestellterJob.dateiname, 'rechnung.pdf');
  assert.equal(wiederhergestellterJob.pdf_pfad, join(restored.current.jobsDir, 'rechnung.pdf'));

  // The restore audit entry is part of the prepared database before activation.
  const eintraege = listBackupWiederherstellungen(wiederhergestellteDb);
  assert.equal(eintraege.length, 1);
  assert.equal(eintraege[0].dateiname, 'hochgeladenes-backup.zip');
  assert.equal(eintraege[0].wiederhergestellt_von, '1');
  wiederhergestellteDb.close();

  // Dateien kamen vollständig an.
  assert.equal(readFileSync(join(restored.current.jobsDir, 'rechnung.pdf'), 'utf8'), 'pdf-inhalt');
  assert.equal(readFileSync(join(restored.current.brandingDir, 'logo.png'), 'utf8'), 'logo-inhalt');

  rmSync(quellDir, { recursive: true, force: true });
  rmSync(zielDir, { recursive: true, force: true });
});

test('offline restore records the maintenance operator even when absent from the backed-up persons', () => {
  // Der realistische Betriebsfall: Ein Admin spielt ein Archiv ein, das älter ist als sein eigenes
  // Konto -- die personen-Tabelle im Archiv kennt ihn nicht. Der Audit-Eintrag wird in genau diese
  // wiederhergestellte Datenbank geschrieben; ein Foreign Key auf personen hätte hier zugeschlagen
  // und einen bereits vollständig erfolgreichen Restore als Fehler gemeldet.
  const quellDir = mkdtempSync(join(tmpdir(), 'backup-quelle-fk-'));
  const zielDir = mkdtempSync(join(tmpdir(), 'backup-ziel-fk-'));
  const quellConfig = {
    jobsDir: join(quellDir, 'jobs'),
    brandingDir: join(quellDir, 'branding'),
    backupDir: join(quellDir, 'backups'),
    dbPath: join(quellDir, 'quelle.sqlite'),
  };
  const zielConfig = {
    jobsDir: join(zielDir, 'jobs'),
    brandingDir: join(zielDir, 'branding'),
    backupDir: join(zielDir, 'backups'),
    dbPath: join(zielDir, 'ziel.sqlite'),
  };

  const quellDb = openDatabase(quellConfig.dbPath);
  seedDefaults(quellDb);
  upsertPerson(quellDb, { id: '1', vorname: 'Alt', nachname: 'Person', email: 'alt@example.org', gruppen: [], loggedInNow: false });
  const archiv = buildBackupArchive(quellDb, quellConfig);
  quellDb.close();

  const zielDb = openDatabase(zielConfig.dbPath);
  upsertPerson(zielDb, { id: '99', vorname: 'Neue', nachname: 'Adminperson', email: 'neu@example.org', gruppen: [], loggedInNow: false });
  zielDb.close();
  const restored = restoreOffline(archiv, zielConfig, {
    expectedSha256: createHash('sha256').update(archiv).digest('hex'),
    operator: '99', reason: 'Wiederherstellungsprobe', sourceName: 'altes-backup.zip',
  });

  const wiederhergestellteDb = openDatabase(restored.current.dbPath);
  // Person 99 existiert in der wiederhergestellten personen-Tabelle nicht ...
  assert.equal(wiederhergestellteDb.prepare('SELECT COUNT(*) AS n FROM personen WHERE churchtools_person_id = ?').get('99').n, 0);
  // ... der Audit-Eintrag ist trotzdem da.
  const eintraege = listBackupWiederherstellungen(wiederhergestellteDb);
  assert.equal(eintraege.length, 1);
  assert.equal(eintraege[0].wiederhergestellt_von, '99');
  assert.equal(eintraege[0].dateiname, 'altes-backup.zip');
  wiederhergestellteDb.close();

  rmSync(quellDir, { recursive: true, force: true });
  rmSync(zielDir, { recursive: true, force: true });
});

test('the legacy live-restore service is disabled even when called directly', () => {
  assert.throws(() => restoreBackupArchive(Buffer.from('unused')), /Live-Restore ist gesperrt/);
});

test('buildBackupArchive writes the file counts of jobs/ and branding/ into manifest.json', () => {
  const quellDir = mkdtempSync(join(tmpdir(), 'backup-manifest-'));
  const quellConfig = {
    jobsDir: join(quellDir, 'jobs'),
    brandingDir: join(quellDir, 'branding'),
    backupDir: join(quellDir, 'backups'),
    dbPath: join(quellDir, 'quelle.sqlite'),
  };
  mkdirSync(quellConfig.jobsDir, { recursive: true });
  mkdirSync(quellConfig.brandingDir, { recursive: true });
  writeFileSync(join(quellConfig.jobsDir, 'a.pdf'), 'a');
  writeFileSync(join(quellConfig.jobsDir, 'b.pdf'), 'b');
  writeFileSync(join(quellConfig.brandingDir, 'logo.png'), 'logo');

  const quellDb = openDatabase(quellConfig.dbPath);
  const archiv = buildBackupArchive(quellDb, quellConfig);
  quellDb.close();

  const manifest = JSON.parse(new AdmZip(archiv).readAsText('manifest.json'));
  assert.equal(manifest.dateiAnzahlJobs, 2);
  assert.equal(manifest.dateiAnzahlBranding, 1);

  rmSync(quellDir, { recursive: true, force: true });
});

test('validateBackupArchive throws BackupValidationError for a manifest with a newer formatVersion', () => {
  const quellDir = mkdtempSync(join(tmpdir(), 'backup-version-'));
  const quellConfig = {
    jobsDir: join(quellDir, 'jobs'),
    brandingDir: join(quellDir, 'branding'),
    backupDir: join(quellDir, 'backups'),
    dbPath: join(quellDir, 'quelle.sqlite'),
  };
  const quellDb = openDatabase(quellConfig.dbPath);
  const archiv = buildBackupArchive(quellDb, quellConfig);
  quellDb.close();

  // Gültiges Archiv, nur das Manifest behauptet eine neuere Portal-Version.
  const zip = new AdmZip(archiv);
  const manifest = JSON.parse(zip.readAsText('manifest.json'));
  zip.updateFile('manifest.json', Buffer.from(JSON.stringify({ ...manifest, formatVersion: manifest.formatVersion + 1 })));
  assert.doesNotThrow(() => validateBackupArchive(archiv));
  assert.throws(() => validateBackupArchive(zip.toBuffer()), BackupValidationError);

  rmSync(quellDir, { recursive: true, force: true });
});

test('validateBackupArchive throws BackupValidationError for a non-ZIP buffer', () => {
  assert.throws(() => validateBackupArchive(Buffer.from('not a zip file')), BackupValidationError);
});

test('validateBackupArchive throws BackupValidationError for a ZIP missing db.sqlite', () => {
  const zip = new AdmZip();
  zip.addFile('manifest.json', Buffer.from('{}'));
  assert.throws(() => validateBackupArchive(zip.toBuffer()), BackupValidationError);
});

test('validateBackupArchive throws BackupValidationError for a well-formed ZIP whose db.sqlite is corrupt', () => {
  // node:sqlite's DatabaseSync constructor does not read the file header and does not throw on
  // garbage bytes -- the real error only surfaces on the first query. This must still come out of
  // validateBackupArchive as a BackupValidationError, not a raw SQLite error.
  const zip = new AdmZip();
  zip.addFile('manifest.json', Buffer.from(JSON.stringify({ formatVersion: 1, erstelltAm: new Date().toISOString() })));
  zip.addFile('db.sqlite', Buffer.from('this is not a valid sqlite database file, just garbage padding'));
  assert.throws(() => validateBackupArchive(zip.toBuffer()), BackupValidationError);
});
