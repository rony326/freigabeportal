import { mkdirSync, existsSync, writeFileSync, openSync, closeSync, fsyncSync, rmSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve, relative, sep, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { hostname } from 'node:os';
import { buildBackupArchive, validateBackupArchive } from './backup.js';
import { openDatabase } from '../db/index.js';
import { logBackupWiederherstellung } from '../db/backupWiederherstellungenRepo.js';
import { withAuditActor } from './auditContext.js';
import { acquireStorageLock, storagePaths, readStoragePointer, absoluteStorageConfig, atomicJson, syncDirectory } from './storageState.js';

function maintenanceIdentity(options) {
  const operator = typeof options.operator === 'string' ? options.operator.trim() : '';
  const reason = typeof options.reason === 'string' ? options.reason.trim() : '';
  if (!operator || operator.length > 200 || !reason || reason.length > 2000) throw new Error('Operator (max. 200 Zeichen) und Begruendung (max. 2000 Zeichen) sind erforderlich.');
  return { operator, reason, host: hostname(), osUid: process.getuid?.() ?? null };
}

function journal(paths, event) {
  const fd = openSync(`${paths.baseDbPath}.maintenance.jsonl`, 'a', 0o600);
  try { writeFileSync(fd, `${JSON.stringify({ ...event, zeitpunkt: new Date().toISOString() })}\n`); fsyncSync(fd); }
  finally { closeSync(fd); }
  syncDirectory(dirname(paths.baseDbPath));
}

function durableFile(path, bytes) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
}

function rebase(path, kind, source, destination) {
  if (!path) return path;
  const suffix = relative(source[kind], resolve(source.cwd, path));
  if (!suffix || suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) throw new Error('Dateipfad liegt ausserhalb des Backup-Verzeichnisses.');
  return join(destination[kind === 'jobs' ? 'jobsDir' : 'brandingDir'], suffix);
}

function assertDatabaseIntegrity(db) {
  const rows = db.prepare('PRAGMA integrity_check').all();
  if (rows.length !== 1 || rows[0].integrity_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Wiederhergestellte Datenbank ist nicht konsistent.');
}

function isWithin(path, root) {
  const suffix = relative(resolve(root), path);
  return !suffix || suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}

export function restoreOffline(buffer, config, options = {}) {
  const identity = maintenanceIdentity(options);
  const digest = createHash('sha256').update(buffer).digest('hex');
  if (typeof options.expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(options.expectedSha256) || digest !== options.expectedSha256) {
    throw new Error('Backup-SHA-256 fehlt oder stimmt nicht mit dem erwarteten Wert ueberein.');
  }
  const lock = acquireStorageLock(config, 'restore');
  let generation;
  let activated = false;
  try {
    const { zip, manifest } = validateBackupArchive(buffer);
    const previousPointer = readStoragePointer(config, { requireComplete: false });
    const previous = previousPointer?.current || absoluteStorageConfig(config);
    if ([config.jobsDir, config.brandingDir, config.backupDir, previous.jobsDir, previous.brandingDir].filter(Boolean).some((root) => isWithin(lock.generationsPath, root))) {
      throw new Error('Generationsverzeichnis darf nicht innerhalb von Beleg-, Branding- oder Backup-Verzeichnissen liegen.');
    }
    mkdirSync(lock.generationsPath, { recursive: true, mode: 0o700 });
    if (realpathSync(lock.generationsPath) !== lock.generationsPath) throw new Error('Generationsverzeichnis darf kein symbolischer Link sein.');
    generation = join(lock.generationsPath, randomUUID());
    mkdirSync(generation, { mode: 0o700 });
    const current = { dbPath: join(generation, 'db.sqlite'), jobsDir: join(generation, 'jobs'), brandingDir: join(generation, 'branding') };
    mkdirSync(current.jobsDir, { mode: 0o700 });
    mkdirSync(current.brandingDir, { mode: 0o700 });
    const directories = new Set([generation, current.jobsDir, current.brandingDir]);
    for (const entry of zip.getEntries()) {
      if (entry.entryName === 'manifest.json') continue;
      const path = join(generation, entry.entryName);
      if (entry.isDirectory) mkdirSync(path, { recursive: true, mode: 0o700 });
      else durableFile(path, entry.getData());
      let parent = entry.isDirectory ? path : dirname(path);
      while (parent !== generation) { directories.add(parent); parent = dirname(parent); }
    }
    options.onPhase?.('extracted');
    const db = openDatabase(current.dbPath);
    try {
      withAuditActor({ id: `maintenance:${identity.operator}`, name: identity.operator }, () => {
        db.exec('BEGIN IMMEDIATE');
        try {
          for (const job of db.prepare('SELECT id, pdf_pfad, thumbnail_pfad, gruppe_pdf_pfad FROM jobs').all()) {
            db.prepare('UPDATE jobs SET pdf_pfad = ?, thumbnail_pfad = ?, gruppe_pdf_pfad = ? WHERE id = ?').run(
              rebase(job.pdf_pfad, 'jobs', manifest.quellpfade, current),
              rebase(job.thumbnail_pfad, 'jobs', manifest.quellpfade, current),
              rebase(job.gruppe_pdf_pfad, 'jobs', manifest.quellpfade, current), job.id);
          }
          // Kreditkarten-Belege liegen ebenfalls unter jobsDir. Nach der Fristlöschung verworfener
          // Belege sind beide Pfade NULL -- rebase() reicht NULL unverändert durch.
          for (const beleg of db.prepare('SELECT id, pdf_pfad, thumbnail_pfad FROM kk_belege WHERE pdf_pfad IS NOT NULL OR thumbnail_pfad IS NOT NULL').all()) {
            db.prepare('UPDATE kk_belege SET pdf_pfad = ?, thumbnail_pfad = ? WHERE id = ?').run(
              rebase(beleg.pdf_pfad, 'jobs', manifest.quellpfade, current),
              rebase(beleg.thumbnail_pfad, 'jobs', manifest.quellpfade, current), beleg.id);
          }
          const logo = db.prepare("SELECT value FROM admin_config WHERE key = 'branding_logo_pfad'").get();
          if (logo?.value) db.prepare("UPDATE admin_config SET value = ? WHERE key = 'branding_logo_pfad'").run(rebase(logo.value, 'branding', manifest.quellpfade, current));
          db.exec('DELETE FROM sessions');
          logBackupWiederherstellung(db, { dateiname: options.sourceName || 'Offline-Backup', wiederhergestelltVon: identity.operator });
          db.prepare(`INSERT INTO audit_ereignisse (zeitpunkt, person_id, person_name, objekt, objekt_id, aktion, nachher, begruendung)
            VALUES (?, ?, ?, 'backup', ?, 'offline_restore_vorbereitet', ?, ?)`).run(
            new Date().toISOString(), `maintenance:${identity.operator}`, identity.operator, digest,
            JSON.stringify({ current, previous, backupSha256: digest }), identity.reason);
          assertDatabaseIntegrity(db);
          db.exec('COMMIT');
        } catch (err) { db.exec('ROLLBACK'); throw err; }
      });
      db.exec('PRAGMA secure_delete = ON; VACUUM;');
    } finally { db.close(); }
    const fd = openSync(current.dbPath, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    atomicJson(join(generation, 'ready.json'), { version: 1, backupSha256: digest, baseDbPath: lock.baseDbPath, ...identity });
    for (const path of [...directories].sort((a, b) => b.length - a.length)) syncDirectory(path);
    syncDirectory(lock.generationsPath);
    syncDirectory(dirname(lock.generationsPath));
    options.onPhase?.('prepared');
    lock.assertHeld();
    const pointer = { version: 1, baseDbPath: lock.baseDbPath, current, previous, backupSha256: digest, activatedAt: new Date().toISOString(), ...identity };
    journal(lock, { aktion: 'restore_activation_intent', ...pointer });
    options.onPhase?.('beforeActivation');
    atomicJson(lock.pointerPath, pointer);
    activated = true;
    options.onPhase?.('activated');
    journal(lock, { aktion: 'restore_activated', ...pointer });
    return { ...pointer, pointerPath: lock.pointerPath };
  } catch (err) {
    // A failure after rename/fsync may already have selected the complete new generation.
    // Never delete a directory that the persistent pointer might reference.
    let selected = activated;
    try { selected ||= generation && dirname(readStoragePointer(config, { requireComplete: false })?.current.dbPath || '') === generation; }
    catch { selected = true; }
    if (generation && !selected) rmSync(generation, { recursive: true, force: true });
    try { journal(lock, { aktion: 'restore_failed', ...identity, backupSha256: digest, possiblyActivated: Boolean(selected), error: err.message }); }
    catch { /* Preserve the original failure and both data generations if journaling fails. */ }
    if (selected) err.message += ' Der aktive Datenstand wurde moeglicherweise bereits umgeschaltet; Status vor Neustart pruefen. Beide Datenstaende bleiben erhalten.';
    throw err;
  } finally { lock.release(); }
}

export function rollbackOffline(config, options = {}) {
  const identity = maintenanceIdentity(options);
  const lock = acquireStorageLock(config, 'rollback');
  try {
    const pointer = readStoragePointer(config, { requireComplete: false });
    if (!pointer?.previous) throw new Error('Kein vorheriger Datenstand fuer den Rueckwechsel vorhanden.');
    const current = pointer.previous;
    if (!['dbPath', 'jobsDir', 'brandingDir'].every((key) => typeof current[key] === 'string' && isAbsolute(current[key]) && existsSync(current[key]))) {
      throw new Error('Vorheriger Datenstand ist unvollstaendig.');
    }
    if (!statSync(current.dbPath).isFile() || !statSync(current.jobsDir).isDirectory() || !statSync(current.brandingDir).isDirectory()) throw new Error('Vorheriger Datenstand ist ungueltig.');
    const db = new DatabaseSync(current.dbPath, { readOnly: true });
    try { db.exec('PRAGMA trusted_schema = OFF'); assertDatabaseIntegrity(db); } finally { db.close(); }
    const previousDb = openDatabase(current.dbPath);
    try {
      buildBackupArchive(previousDb, { ...config, ...current });
      previousDb.exec('PRAGMA secure_delete = ON; DELETE FROM sessions; VACUUM;');
      previousDb.prepare(`INSERT INTO audit_ereignisse (zeitpunkt, person_id, person_name, objekt, objekt_id, aktion, begruendung)
        VALUES (?, ?, ?, 'storage', ?, 'offline_rollback_vorbereitet', ?)`).run(
        new Date().toISOString(), `maintenance:${identity.operator}`, identity.operator, current.dbPath, identity.reason);
    } finally { previousDb.close(); }
    const fd = openSync(current.dbPath, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    const next = { version: 1, baseDbPath: lock.baseDbPath, current, previous: pointer.current, activatedAt: new Date().toISOString(), ...identity };
    journal(lock, { aktion: 'rollback_activation_intent', ...next });
    lock.assertHeld();
    atomicJson(lock.pointerPath, next);
    journal(lock, { aktion: 'rollback_activated', ...next });
    return next;
  } finally { lock.release(); }
}

export function offlineRestoreStatus(config) {
  const paths = storagePaths(config);
  return { locked: existsSync(paths.lockPath), lockPath: paths.lockPath, pointerPath: paths.pointerPath, pointer: readStoragePointer(config, { requireComplete: false }) };
}
