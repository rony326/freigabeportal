import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import AdmZip from 'adm-zip';
import { openDatabase } from '../../src/db/index.js';
import { createJob } from '../../src/db/jobsRepo.js';
import { buildBackupArchive, validateBackupArchive, BackupValidationError, BACKUP_LIMITS } from '../../src/services/backup.js';

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'backup-security-'));
  const config = { jobsDir: join(dir, 'jobs'), brandingDir: join(dir, 'branding') };
  mkdirSync(config.jobsDir);
  mkdirSync(config.brandingDir);
  writeFileSync(join(config.jobsDir, 'a.pdf'), 'safe pdf');
  const db = openDatabase(':memory:');
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, db, config, build: () => buildBackupArchive(db, config) };
}

function updateManifest(zip, change) {
  const manifest = JSON.parse(zip.readAsText('manifest.json'));
  change(manifest);
  zip.updateFile('manifest.json', Buffer.from(JSON.stringify(manifest)));
}

test('backup checks the final hash of an unsigned group independently of its original invoice', (t) => {
  const s = setup(t);
  const groupPath = join(s.config.jobsDir, 'group.pdf');
  writeFileSync(groupPath, 'group document');
  const id = createJob(s.db, { eingangAm: '2026-09-28T00:00:00Z', quelle: 'scanner', dateiname: 'a.pdf', pdfPfad: join(s.config.jobsDir, 'a.pdf') });
  const hash = createHash('sha256').update('group document').digest('hex');
  s.db.prepare("UPDATE jobs SET status = 'aufgesplittet', gruppe_pdf_pfad = ?, gruppe_final_datei_hash = ? WHERE id = ?").run(groupPath, hash, id);
  assert.doesNotThrow(() => validateBackupArchive(s.build()));
  writeFileSync(groupPath, 'tampered group');
  assert.throws(() => s.build(), /finalen Datenbank-Hash/);
});

test('format 2 records exact per-file SHA-256 and excludes live sessions without deleting them', (t) => {
  const s = setup(t);
  s.db.prepare('INSERT INTO sessions (sid, sess, expires) VALUES (?, ?, ?)').run('secret-session', '{"token":"live-secret"}', '2099-01-01');
  const { zip, manifest } = validateBackupArchive(s.build());
  assert.equal(manifest.formatVersion, 2);
  for (const file of manifest.dateien) {
    const data = zip.getEntry(file.pfad).getData();
    assert.equal(data.length, file.groesse);
    assert.equal(createHash('sha256').update(data).digest('hex'), file.sha256);
  }
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM sessions').get().n, 1);
  const path = join(s.dir, 'snapshot.sqlite');
  writeFileSync(path, zip.getEntry('db.sqlite').getData());
  assert.equal(readFileSync(path).includes(Buffer.from('live-secret')), false, 'session credentials must also be absent from free SQLite pages');
  const snapshot = new DatabaseSync(path, { readOnly: true });
  try { assert.equal(snapshot.prepare('SELECT count(*) AS n FROM sessions').get().n, 0); }
  finally { snapshot.close(); }
});

test('tampered, missing and undeclared files are rejected', (t) => {
  const s = setup(t);
  const original = s.build();
  for (const mutate of [
    (zip) => zip.updateFile('jobs/a.pdf', Buffer.from('bad! pdf')),
    (zip) => zip.deleteFile('jobs/a.pdf'),
    (zip) => { zip.addFile('jobs/extra.pdf', Buffer.from('extra')); updateManifest(zip, (m) => { m.dateiAnzahlJobs = 2; }); },
    (zip) => updateManifest(zip, (m) => { m.dateien.push(m.dateien[0]); }),
    (zip) => updateManifest(zip, (m) => { m.dateiAnzahlJobs = '1'; }),
  ]) {
    const zip = new AdmZip(original);
    mutate(zip);
    assert.throws(() => validateBackupArchive(zip.toBuffer()), BackupValidationError);
  }
});

test('unknown, legacy and incorrectly typed format versions are rejected', (t) => {
  const s = setup(t);
  const original = s.build();
  for (const version of [null, 0, 1, '2', 3]) {
    const zip = new AdmZip(original);
    updateManifest(zip, (m) => { m.formatVersion = version; });
    assert.throws(() => validateBackupArchive(zip.toBuffer()), /Backup-Format 2/);
  }
});

test('traversal, absolute, backslash and ambiguous file names are rejected before extraction', (t) => {
  const s = setup(t);
  const original = s.build();
  for (const name of ['../escape', '/tmp/escape', 'jobs/../../escape', 'jobs\\escape.pdf', 'jobs/C:escape', 'jobs//a.pdf', 'jobs/./a.pdf', 'jobs/a.pdf ']) {
    const zip = new AdmZip(original);
    zip.getEntry('jobs/a.pdf').entryName = name;
    assert.throws(() => validateBackupArchive(zip.toBuffer()), /Unzulaessiger Pfad/);
  }
});

test('duplicate portable names, file-directory collisions and symlinks are rejected', (t) => {
  const s = setup(t);
  const original = s.build();
  const duplicate = new AdmZip(original);
  duplicate.addFile('jobs/A.pdf', Buffer.from('other'));
  assert.throws(() => validateBackupArchive(duplicate.toBuffer()), /Doppelter Pfad/);
  const collision = new AdmZip(original);
  collision.addFile('jobs/a.pdf/nested.pdf', Buffer.from('other'));
  assert.throws(() => validateBackupArchive(collision.toBuffer()), /kollidiert/);
  const symlink = new AdmZip(original);
  symlink.getEntry('jobs/a.pdf').attr = (0o120777 << 16) >>> 0;
  assert.throws(() => validateBackupArchive(symlink.toBuffer()), /Links und Spezialdateien/);
});

test('oversized declared ZIP entry is rejected before decompression or allocation', (t) => {
  const s = setup(t);
  const archive = s.build();
  const central = archive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert.ok(central >= 0);
  archive.writeUInt32LE(BACKUP_LIMITS.entryBytes + 1, central + 24);
  assert.throws(() => validateBackupArchive(archive), /Entpackgroesse/);
});

test('backup creation rejects symbolic links instead of following them outside the data directory', (t) => {
  const s = setup(t);
  const secret = join(s.dir, 'secret.txt');
  writeFileSync(secret, 'do not export');
  symlinkSync(secret, join(s.config.jobsDir, 'secret-link'));
  assert.throws(() => s.build(), BackupValidationError);
});

test('a missing active PDF and a DB path outside the configured root invalidate backup creation', (t) => {
  const s = setup(t);
  const id = createJob(s.db, { eingangAm: '2026-09-27T00:00:00Z', quelle: 'scanner', dateiname: 'a.pdf', pdfPfad: join(s.config.jobsDir, 'missing.pdf') });
  assert.throws(() => s.build(), /Dateireferenz fehlt/);
  s.db.prepare('UPDATE jobs SET pdf_pfad = ? WHERE id = ?').run(join(s.dir, 'outside.pdf'), id);
  assert.throws(() => s.build(), /ausserhalb/);
});

test('removing a referenced PDF remains invalid even after recomputing the whole manifest', (t) => {
  const s = setup(t);
  createJob(s.db, { eingangAm: '2026-09-27T00:00:00Z', quelle: 'scanner', dateiname: 'a.pdf', pdfPfad: join(s.config.jobsDir, 'a.pdf') });
  const zip = new AdmZip(s.build());
  zip.deleteFile('jobs/a.pdf');
  updateManifest(zip, (m) => {
    m.dateien = m.dateien.filter((file) => file.pfad !== 'jobs/a.pdf');
    m.dateiAnzahlJobs = 0;
  });
  assert.throws(() => validateBackupArchive(zip.toBuffer()), /Dateireferenz fehlt/);
});

test('foreign-key violations are rejected even with valid file hashes', (t) => {
  const s = setup(t);
  const zip = new AdmZip(s.build());
  const path = join(s.dir, 'broken.sqlite');
  writeFileSync(path, zip.getEntry('db.sqlite').getData());
  const broken = openDatabase(path);
  broken.exec('PRAGMA foreign_keys = OFF');
  broken.prepare("INSERT INTO person_berechtigungen (person_id, berechtigung) VALUES ('missing-person', 'sync_einsehen')").run();
  broken.close();
  const bytes = readFileSync(path);
  zip.updateFile('db.sqlite', bytes);
  updateManifest(zip, (m) => {
    const file = m.dateien.find((f) => f.pfad === 'db.sqlite');
    file.groesse = bytes.length;
    file.sha256 = createHash('sha256').update(bytes).digest('hex');
  });
  assert.throws(() => validateBackupArchive(zip.toBuffer()), /Fremdschluessel/);
});

test('backup creation rejects document bytes that contradict a stored final hash', (t) => {
  const s = setup(t);
  const id = createJob(s.db, { eingangAm: '2026-09-27T00:00:00Z', quelle: 'scanner', dateiname: 'a.pdf', pdfPfad: join(s.config.jobsDir, 'a.pdf') });
  s.db.prepare("UPDATE jobs SET status = 'abgeschlossen', final_datei_hash = ? WHERE id = ?").run('0'.repeat(64), id);
  assert.throws(() => s.build(), /finalen Datenbank-Hash/);
});
