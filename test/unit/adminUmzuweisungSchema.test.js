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

function spalten(db, tabelle) {
  return db.prepare(`PRAGMA table_info(${tabelle})`).all().map((c) => c.name);
}

function seed(db) {
  upsertPerson(db, { id: '1', vorname: 'P', nachname: 'Eins', email: 'p1@example.org', gruppen: [], loggedInNow: false });
  upsertPerson(db, { id: '2', vorname: 'P', nachname: 'Zwei', email: 'p2@example.org', gruppen: [], loggedInNow: false });
  return createJob(db, { eingangAm: '2026-10-01T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
}

test('frische DB: neue Spalten, Rolle, Mail-Typ und Recht sind vorhanden', () => {
  const db = openDatabase(':memory:');
  assert.ok(spalten(db, 'jobs').includes('freigabe2_umgeleitet_an'));
  assert.ok(spalten(db, 'freigaben').includes('vorher_zustaendig'));
  assert.ok(spalten(db, 'freigaben').includes('ziel_person_id'));
  const jobId = seed(db);
  createFreigabe(db, {
    jobId, personId: '1', rolle: 'admin_umzuweisung', zeitpunkt: '2026-10-01T09:00:00.000Z', ip: '127.0.0.1',
    interessenskonflikt: false, kommentar: 'Von Pool an P Zwei: Test', eskaliertVon: null, vorherZustaendig: null, zielPersonId: '2',
  });
  const [eintrag] = listFreigabenByJob(db, jobId);
  assert.equal(eintrag.rolle, 'admin_umzuweisung');
  assert.equal(eintrag.ziel_person_id, '2');
  assert.equal(eintrag.vorher_zustaendig, null);
  assert.doesNotThrow(() =>
    db.prepare("INSERT INTO mail_log (typ, job_id, empfaenger, betreff, text, status, versucht_am) VALUES ('admin-umzuweisung', NULL, 'x@example.org', 'B', 'T', 'eingereiht', '2026-10-01')").run()
  );
  assert.doesNotThrow(() => db.prepare("INSERT INTO person_berechtigungen (person_id, berechtigung) VALUES ('1', 'vorgaenge_einsehen')").run());
  db.close();
});

test('bestehende DB mit altem freigaben-/mail_log-CHECK wird migriert, ohne Daten zu verlieren', () => {
  const dir = mkdtempSync(join(tmpdir(), 'umzuweisung-schema-'));
  const pfad = join(dir, 'portal.db');
  let db = openDatabase(pfad);
  const jobId = seed(db);
  createFreigabe(db, { jobId, personId: '1', rolle: 'freigeber1', zeitpunkt: '2026-10-01T09:00:00.000Z', ip: '1.2.3.4', interessenskonflikt: false, kommentar: null, eskaliertVon: null });
  db.close();

  // Stand vor diesem Feature nachbauen: alter CHECK, ohne die zwei neuen Spalten.
  const raw = new DatabaseSync(pfad);
  raw.exec('PRAGMA foreign_keys = OFF');
  raw.exec(`
    ALTER TABLE freigaben RENAME TO f_neu;
    CREATE TABLE freigaben (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL REFERENCES jobs(id),
      person_id TEXT NOT NULL REFERENCES personen(churchtools_person_id),
      rolle TEXT NOT NULL CHECK (rolle IN ('freigeber1', 'freigeber2', 'ablehnung', 'freigabe1_eskalation', 'freigabe2_eskalation', 'iban_abweichung', 'rechnungsnummer_duplikat', 'pool_zuweisung', 'pool_ruecksendung', 'freigabe1_weiterleitung', 'kk_abrechnung_markiert', 'kk_markierung_aufgehoben', 'kk_abgleich')),
      zeitpunkt TEXT NOT NULL,
      ip TEXT NOT NULL,
      interessenskonflikt INTEGER NOT NULL DEFAULT 0,
      kommentar TEXT,
      eskaliert_von TEXT REFERENCES personen(churchtools_person_id),
      vertretung_fuer TEXT REFERENCES personen(churchtools_person_id)
    );
    INSERT INTO freigaben SELECT id, job_id, person_id, rolle, zeitpunkt, ip, interessenskonflikt, kommentar, eskaliert_von, vertretung_fuer FROM f_neu;
    DROP TABLE f_neu;
  `);
  raw.close();

  db = openDatabase(pfad);
  const eintraege = listFreigabenByJob(db, jobId);
  assert.equal(eintraege.length, 1);
  assert.equal(eintraege[0].rolle, 'freigeber1');
  assert.ok(spalten(db, 'freigaben').includes('ziel_person_id'));
  assert.doesNotThrow(() =>
    createFreigabe(db, { jobId, personId: '1', rolle: 'admin_umzuweisung', zeitpunkt: '2026-10-01T10:00:00.000Z', ip: '1.2.3.4', interessenskonflikt: false, kommentar: 'x', eskaliertVon: null, zielPersonId: '2' })
  );
  // Audit-Trigger wurden nach dem Neuaufbau wieder angelegt und kennen die neue Spalte.
  const trigger = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'audit_freigaben_INSERT'").get();
  assert.ok(trigger && trigger.sql.includes('ziel_person_id'));
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'mail_log_zustellung_idx'").get());
  db.close();
  openDatabase(pfad).close(); // idempotent
  rmSync(dir, { recursive: true, force: true });
});
