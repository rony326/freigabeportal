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

const ALTE_ROLLEN = ['freigeber1', 'freigeber2', 'ablehnung', 'freigabe1_eskalation', 'freigabe2_eskalation', 'iban_abweichung', 'rechnungsnummer_duplikat', 'pool_zuweisung', 'pool_ruecksendung', 'freigabe1_weiterleitung', 'kk_abrechnung_markiert', 'kk_markierung_aufgehoben', 'kk_abgleich', 'admin_umzuweisung', 'duplikat_verdacht', 'rapport_markiert', 'rapport_bestaetigt', 'rapport_empfaenger_ersetzt', 'rapport_empfaenger_entfernt', 'rapport_markierung_aufgehoben'];

function neuerEintrag(db, jobId, rolle) {
  createFreigabe(db, { jobId, personId: '1', rolle, zeitpunkt: '2026-11-10T09:00:00.000Z', ip: '1.2.3.4', interessenskonflikt: false, kommentar: 'x', eskaliertVon: null });
}

test('freigaben-CHECK: alte DB behält Zeilen, akzeptiert die neuen Rollen, Wiederöffnen ist idempotent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'betrug-rollen-'));
  const pfad = join(dir, 'portal.db');
  let db = openDatabase(pfad);
  upsertPerson(db, { id: '1', vorname: 'P', nachname: 'Eins', email: 'p1@example.org', gruppen: [], loggedInNow: false });
  const jobId = createJob(db, { eingangAm: '2026-11-10T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  neuerEintrag(db, jobId, 'freigeber1');
  db.close();

  // Stand vor dieser Änderung: CHECK ohne die beiden neuen Rollen.
  const raw = new DatabaseSync(pfad);
  raw.exec('PRAGMA foreign_keys = OFF');
  raw.exec(`
    ALTER TABLE freigaben RENAME TO f_neu;
    CREATE TABLE freigaben (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL REFERENCES jobs(id),
      person_id TEXT NOT NULL REFERENCES personen(churchtools_person_id),
      rolle TEXT NOT NULL CHECK (rolle IN (${ALTE_ROLLEN.map((r) => `'${r}'`).join(', ')})),
      zeitpunkt TEXT NOT NULL,
      ip TEXT NOT NULL,
      interessenskonflikt INTEGER NOT NULL DEFAULT 0,
      kommentar TEXT,
      eskaliert_von TEXT REFERENCES personen(churchtools_person_id),
      vertretung_fuer TEXT REFERENCES personen(churchtools_person_id),
      vorher_zustaendig TEXT REFERENCES personen(churchtools_person_id),
      ziel_person_id TEXT REFERENCES personen(churchtools_person_id)
    );
    INSERT INTO freigaben SELECT * FROM f_neu;
    DROP TABLE f_neu;
  `);
  assert.throws(() => raw.exec("INSERT INTO freigaben (job_id, person_id, rolle, zeitpunkt, ip) VALUES (1, '1', 'iban_manuell_geprueft', 'z', 'i')"));
  raw.close();

  for (let durchgang = 0; durchgang < 2; durchgang += 1) {
    db = openDatabase(pfad);
    assert.equal(listFreigabenByJob(db, jobId).filter((f) => f.rolle === 'freigeber1').length, 1, 'bestehende Zeile bleibt');
    if (durchgang === 0) {
      assert.doesNotThrow(() => neuerEintrag(db, jobId, 'iban_manuell_geprueft'));
      assert.doesNotThrow(() => neuerEintrag(db, jobId, 'auffaelligkeiten_bestaetigt'));
    }
    assert.equal(listFreigabenByJob(db, jobId).length, 3);
    db.close();
  }
  rmSync(dir, { recursive: true, force: true });
});
