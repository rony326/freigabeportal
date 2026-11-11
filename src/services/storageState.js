// Datenspeicher-Zustand: exklusive Prozesssperre und der "aktive Datenstand" nach einer Offline-Wiederherstellung (docs/offline-restore.md).
// Die Sperre ist ein Verzeichnis neben der Datenbank (`<DB_PATH>.process-lock`); der Zeiger `<DB_PATH>.active.json` verweist nach einem
// Restore auf den aktiven Satz aus Datenbank, Belegen und Erscheinungsbild.

import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync, rmdirSync, realpathSync, openSync, closeSync, fsyncSync, renameSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

// Berechnet Sperr-, Zeiger- und Generationenpfade (realpath-aufgelöst; DB_PATH darf kein Symlink sein).
export function storagePaths(config) {
  if (!config.dbPath || config.dbPath === ':memory:') throw new Error('Wartungsbetrieb verlangt einen persistenten DB_PATH.');
  const configured = resolve(config.dbPath);
  mkdirSync(dirname(configured), { recursive: true });
  const baseDbPath = join(realpathSync(dirname(configured)), basename(configured));
  if (existsSync(baseDbPath) && realpathSync(baseDbPath) !== baseDbPath) throw new Error('DB_PATH darf kein symbolischer Link sein.');
  return { baseDbPath, lockPath: `${baseDbPath}.process-lock`, pointerPath: `${baseDbPath}.active.json`, generationsPath: `${baseDbPath}.generations` };
}

// Sperrt den Datenspeicher exklusiv. Wirft, wenn schon ein Prozess ihn hält. @returns {{release: Function, assertHeld: Function}}
export function acquireStorageLock(config, purpose = 'server') {
  const paths = storagePaths(config);
  try { mkdirSync(paths.lockPath, { mode: 0o700 }); }
  catch (err) {
    if (err.code === 'EEXIST') throw new Error(`Datenspeicher ist gesperrt: ${paths.lockPath}. Laufende Prozesse stoppen; verwaiste Sperren nur nach manueller Prüfung entfernen.`);
    throw err;
  }
  const token = randomUUID();
  const ownerPath = join(paths.lockPath, 'owner.json');
  try {
    writeFileSync(ownerPath, JSON.stringify({ token, pid: process.pid, host: hostname(), purpose, startedAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
  } catch (err) { rmdirSync(paths.lockPath); throw err; }
  let released = false;
  return {
    ...paths,
    assertHeld() {
      if (released || JSON.parse(readFileSync(ownerPath, 'utf8')).token !== token) throw new Error('Wartungssperre ist nicht mehr gültig.');
    },
    release() {
      if (released) return;
      this.assertHeld();
      unlinkSync(ownerPath);
      rmdirSync(paths.lockPath);
      released = true;
    },
  };
}

// fsync auf ein Verzeichnis (macht Umbenennungen dauerhaft).
export function syncDirectory(path) {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

// Schreibt eine JSON-Datei atomar (temporär, fsync, rename).
export function atomicJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
    syncDirectory(dirname(path));
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

// Prüft die Pfade eines aktiven Datenstands (absolut, vollständig vorhanden).
function checkedPaths(paths, requireComplete = true) {
  if (!paths || !['dbPath', 'jobsDir', 'brandingDir'].every((key) => typeof paths[key] === 'string' && isAbsolute(paths[key]))) {
    throw new Error('Ungültiger aktiver Datenstand.');
  }
  if (requireComplete && (!statSync(paths.dbPath).isFile() || !statSync(paths.jobsDir).isDirectory() || !statSync(paths.brandingDir).isDirectory())) {
    throw new Error('Aktiver Datenstand ist unvollständig.');
  }
  return { dbPath: paths.dbPath, jobsDir: paths.jobsDir, brandingDir: paths.brandingDir };
}

// Liest den Zeiger auf den aktiven Datenstand oder null, wenn es keinen gibt.
export function readStoragePointer(config, { requireComplete = true } = {}) {
  const { pointerPath, baseDbPath } = storagePaths(config);
  if (!existsSync(pointerPath)) return null;
  const pointer = JSON.parse(readFileSync(pointerPath, 'utf8'));
  if (pointer.version !== 1 || pointer.baseDbPath !== baseDbPath) throw new Error('Unbekannter oder falsch zugeordneter aktiver Datenstand.');
  pointer.current = checkedPaths(pointer.current, requireComplete);
  return pointer;
}

// Liefert die Konfiguration mit den Pfaden des aktiven Datenstands (nach einem Restore weichen sie von den Umgebungsvariablen ab).
export function resolveStorageConfig(config) {
  const pointer = readStoragePointer(config);
  return pointer ? { ...config, ...pointer.current } : config;
}

// Die drei Speicherpfade als absolute Pfade.
export function absoluteStorageConfig(config) {
  return { dbPath: resolve(config.dbPath), jobsDir: resolve(config.jobsDir), brandingDir: resolve(config.brandingDir) };
}
