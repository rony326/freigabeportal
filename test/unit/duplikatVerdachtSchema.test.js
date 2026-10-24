import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createJob } from '../../src/db/jobsRepo.js';
import { createFreigabe, listFreigabenByJob } from '../../src/db/freigabenRepo.js';

function seed(db) {
  upsertPerson(db, { id: '1', vorname: 'P', nachname: 'Eins', email: 'p1@example.org', gruppen: [], loggedInNow: false });
  return createJob(db, { eingangAm: '2026-10-01T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
}

function triggerNamen(db, tabelle) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?").all(tabelle).map((t) => t.name).sort();
}

test('frische DB akzeptiert Rolle duplikat_verdacht und Mail-Typ duplikat-warnung', () => {
  const db = openDatabase(':memory:');
  const jobId = seed(db);
  assert.doesNotThrow(() => createFreigabe(db, { jobId, personId: '1', rolle: 'duplikat_verdacht', zeitpunkt: '2026-10-01T09:00:00.000Z', ip: '::1', interessenskonflikt: false, kommentar: 'x', eskaliertVon: null }));
  assert.doesNotThrow(() => db.prepare("INSERT INTO mail_log (typ, job_id, empfaenger, betreff, text, status, versucht_am) VALUES ('duplikat-warnung', NULL, 'x@example.org', 'B', 'T', 'eingereiht', '2026-10-01')").run());
  db.close();
});

test('bestehende DB mit altem CHECK wird erweitert, Daten, Spalten und Audit-Trigger bleiben erhalten', () => {
  const dir = mkdtempSync(join(tmpdir(), 'duplikat-schema-'));
  const pfad = join(dir, 'portal.db');
  let db = openDatabase(pfad);
  const jobId = seed(db);
  createFreigabe(db, { jobId, personId: '1', rolle: 'admin_umzuweisung', zeitpunkt: '2026-10-01T09:00:00.000Z', ip: '1.2.3.4', interessenskonflikt: false, kommentar: 'k', eskaliertVon: null, zielPersonId: '1' });
  db.prepare("INSERT INTO mail_log (typ, job_id, empfaenger, betreff, text, status, versucht_am) VALUES ('admin-umzuweisung', NULL, 'x@example.org', 'B', 'T', 'eingereiht', '2026-10-01')").run();
  const triggerVorher = triggerNamen(db, 'freigaben');
  db.close();

  // Stand vor diesem Feature nachbauen: CHECKs ohne die neuen Werte.
  const raw = new DatabaseSync(pfad);
  for (const [tabelle, neu, ersatz] of [['freigaben', ", 'duplikat_verdacht'", ''], ['mail_log', ", 'duplikat-warnung'", '']]) {
    const sql = raw.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(tabelle).sql;
    raw.exec('PRAGMA writable_schema = ON');
    raw.prepare("UPDATE sqlite_master SET sql = ? WHERE type = 'table' AND name = ?").run(sql.replace(neu, ersatz), tabelle);
    raw.exec('PRAGMA writable_schema = OFF');
  }
  raw.close();

  db = openDatabase(pfad);
  const eintraege = listFreigabenByJob(db, jobId);
  assert.equal(eintraege.length, 1);
  assert.equal(eintraege[0].ziel_person_id, '1', 'Spalten aus späteren Migrationen werden mitkopiert');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM mail_log WHERE typ = 'admin-umzuweisung'").get().n, 1);
  assert.doesNotThrow(() => createFreigabe(db, { jobId, personId: '1', rolle: 'duplikat_verdacht', zeitpunkt: '2026-10-01T10:00:00.000Z', ip: '1.2.3.4', interessenskonflikt: false, kommentar: 'x', eskaliertVon: null }));
  assert.deepEqual(triggerNamen(db, 'freigaben'), triggerVorher, 'Audit-Trigger werden nach dem Rebuild neu angelegt');
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'mail_log_zustellung_idx'").get());
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
