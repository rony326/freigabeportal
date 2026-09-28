import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../../src/db/index.js';
import { createJob } from '../../src/db/jobsRepo.js';
import { upsertPerson } from '../../src/db/personenRepo.js';

test('the migration is repeatable and the new jobs column is covered by the jobs audit trigger', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'export-schema-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pfad = join(dir, 'portal.db');
  let db = openDatabase(pfad);
  const id = createJob(db, { eingangAm: '2026-09-01T00:00:00Z', quelle: 'scanner', dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare("UPDATE jobs SET gruppe_freigabe_snapshot = '{\"v\":1}' WHERE id = ?").run(id);
  db.close();
  db = openDatabase(pfad);
  t.after(() => db.close());
  assert.equal(db.prepare('SELECT gruppe_freigabe_snapshot FROM jobs WHERE id = ?').get(id).gruppe_freigabe_snapshot, '{"v":1}');
  assert.throws(() => db.prepare('UPDATE jobs SET gruppe_freigabe_snapshot = NULL WHERE id = ?').run(id), /unveraenderlich/);
  const event = db.prepare("SELECT nachher FROM audit_ereignisse WHERE objekt = 'jobs' AND aktion = 'UPDATE' ORDER BY id DESC").get();
  assert.equal(JSON.parse(event.nachher).gruppe_freigabe_snapshot, '{"v":1}');
});

test('an existing database without the new column or table is upgraded without losing jobs', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'export-schema-alt-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pfad = join(dir, 'portal.db');
  let db = openDatabase(pfad);
  const id = createJob(db, { eingangAm: '2026-09-01T00:00:00Z', quelle: 'scanner', dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  db.close();
  // Simulate the state before this package on the raw file.
  const raw = new DatabaseSync(pfad);
  raw.exec('DROP TRIGGER trg_gruppe_freigabe_snapshot_unveraenderlich; DROP TABLE altfall_entscheidungen;');
  for (const action of ['INSERT', 'UPDATE', 'DELETE']) raw.exec(`DROP TRIGGER IF EXISTS audit_jobs_${action}`);
  raw.exec('ALTER TABLE jobs DROP COLUMN gruppe_freigabe_snapshot');
  raw.close();
  db = openDatabase(pfad);
  t.after(() => db.close());
  assert.ok(db.prepare('SELECT id FROM jobs WHERE id = ?').get(id));
  assert.ok(db.prepare('PRAGMA table_info(jobs)').all().some((c) => c.name === 'gruppe_freigabe_snapshot'));
  upsertPerson(db, { id: '1', vorname: 'A', nachname: 'B', email: 'a@example.org', gruppen: [] });
  db.prepare("INSERT INTO altfall_entscheidungen (job_id, entscheidung, angezeigte_daten, stand, person_id, person_name, begruendung, zeitpunkt) VALUES (?, 'nur_archiv', '{}', 's', '1', 'A B', 'grund', 'now')").run(id);
  assert.throws(() => db.prepare("INSERT INTO altfall_entscheidungen (job_id, entscheidung, angezeigte_daten, stand, person_id, person_name, begruendung, zeitpunkt) VALUES (?, 'nur_archiv', '{}', 's', '1', 'A B', 'zweite', 'now')").run(id), /UNIQUE/);
  assert.throws(() => db.prepare("INSERT INTO altfall_entscheidungen (job_id, entscheidung, angezeigte_daten, stand, person_id, person_name, begruendung, zeitpunkt) VALUES (?, 'irgendwas', '{}', 's', '1', 'A B', 'x', 'now')").run(id), /CHECK/);
});
