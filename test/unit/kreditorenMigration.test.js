import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { openDatabase } from '../../src/db/index.js';
import { createKreditor } from '../../src/db/kreditorenRepo.js';
import { createKreditorIban } from '../../src/db/kreditorIbanRepo.js';
import { createZuweisungsregel } from '../../src/db/zuweisungsregelnRepo.js';
import { createJob, getJobById } from '../../src/db/jobsRepo.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { personHasPermission } from '../../src/middleware/permissions.js';
import { kreditorIdAusDatensatz, kreditorIdAusEingabe, kreditorNameVariablen, KreditorFeldKonflikt } from '../../src/services/kreditorFelder.js';

const sha = (text) => createHash('sha256').update(text).digest('hex');

// Baut aus einer aktuellen DB den Stand vor der Umbenennung nach: alte Tabellen-/Spaltennamen,
// alte Audit-Trigger und das alte Recht im CHECK. So wird die echte Bestandsmigration geprueft.
function zuAltstand(db) {
  db.exec(`PRAGMA foreign_keys = OFF; BEGIN;
    ${['kreditoren', 'kreditor_ibans'].flatMap((t) => ['INSERT', 'UPDATE', 'DELETE'].map((a) => `DROP TRIGGER audit_${t}_${a};`)).join('\n')}
    ALTER TABLE kreditoren RENAME TO debitoren;
    ALTER TABLE kreditor_ibans RENAME TO debitor_ibans;
    ALTER TABLE debitor_ibans RENAME COLUMN kreditor_id TO debitor_id;
    ALTER TABLE zuweisungsregeln RENAME COLUMN kreditor_id TO debitor_id;
    ALTER TABLE jobs RENAME COLUMN kreditor_id TO debitor_id;
    CREATE TRIGGER audit_debitoren_UPDATE AFTER UPDATE ON debitoren BEGIN INSERT INTO audit_ereignisse
      (zeitpunkt, person_id, person_name, objekt, objekt_id, aktion) VALUES ('alt', 'system', 'System', 'debitoren', CAST(NEW.id AS TEXT), 'UPDATE'); END;
    CREATE TABLE pb_alt (
      person_id TEXT NOT NULL REFERENCES personen(churchtools_person_id),
      berechtigung TEXT NOT NULL CHECK (berechtigung IN ('konten_verwalten','debitoren_verwalten','geplante_jobs_verwalten','abgelehnt_verwalten','mails_einsehen','sync_einsehen','audit_log_einsehen','pool_zuweisen','sync_verwalten','workflow_eingreifen','kreditkarten_verwalten')),
      PRIMARY KEY (person_id, berechtigung));
    INSERT INTO pb_alt SELECT person_id, CASE berechtigung WHEN 'kreditoren_verwalten' THEN 'debitoren_verwalten' ELSE berechtigung END FROM person_berechtigungen;
    DROP TABLE person_berechtigungen;
    ALTER TABLE pb_alt RENAME TO person_berechtigungen;
    COMMIT; PRAGMA foreign_keys = ON;`);
}

function seedBestand(db) {
  upsertPerson(db, { id: '5', vorname: 'Kara', nachname: 'Kreditor', email: 'k@example.org', gruppen: [], loggedInNow: false });
  db.prepare("INSERT INTO konten (kontonummer, bezeichnung, freigeber1_id, stellvertreter1_id, freigeber2_id, stellvertreter2_id) VALUES ('4400', 'Material', '5', '5', '5', '5')").run();
  const lieferant = createKreditor(db, { name: 'Papier AG', kontoId: 1 });
  const zweiter = createKreditor(db, { name: 'Strom GmbH', kontoId: null });
  createKreditorIban(db, { kreditorId: lieferant, iban: 'CH9300762011623852957', quelle: 'manuell' });
  createZuweisungsregel(db, { absenderMuster: '@papier.example', kreditorId: lieferant });
  const jobId = createJob(db, { eingangAm: '2026-09-01T00:00:00Z', quelle: 'lieferant', absender: 'r@papier.example', dateiname: 'r.pdf', pdfPfad: '/tmp/r.pdf' });
  db.prepare("UPDATE jobs SET betrag = '120.50', rechnungsnummer = 'R-1', status = 'abgeschlossen', abgeschlossen_am = '2026-09-02T00:00:00Z', konto_id = 1 WHERE id = ?").run(jobId);
  // Historischer Freigabe-Snapshot und Exportnachweis mit altem Feldnamen.
  const snapshot = JSON.stringify({ version: 2, job: { id: jobId, debitor_id: lieferant, lieferant: 'Papier AG', betrag: '120.50' }, konto: { id: 1 } });
  db.prepare('UPDATE jobs SET freigabe_snapshot = ?, final_datei_hash = ? WHERE id = ?').run(snapshot, 'f'.repeat(64), jobId);
  db.prepare("INSERT INTO export_nachweise (id, job_id, sha256, manifest, erstellt_am) VALUES ('exp-1', ?, ?, ?, '2026-09-02T00:00:00Z')")
    .run(jobId, 'f'.repeat(64), JSON.stringify({ job: { debitor_id: lieferant } }));
  db.prepare("INSERT INTO person_berechtigungen (person_id, berechtigung) VALUES ('5', 'kreditoren_verwalten')").run();
  return { lieferant, zweiter, jobId, snapshot };
}

test('existing database is migrated without data loss, idempotently, keeping history and hashes intact', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'kreditoren-migration-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pfad = join(dir, 'portal.sqlite');
  let db = openDatabase(pfad);
  const { lieferant, zweiter, jobId, snapshot } = seedBestand(db);
  db.prepare("UPDATE jobs SET kreditor_id = ? WHERE id = ?").run(lieferant, jobId);
  zuAltstand(db);
  const jobVorher = { ...db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) };
  const auditVorher = db.prepare('SELECT * FROM audit_ereignisse ORDER BY id').all().map((row) => ({ ...row }));
  const exportVorher = { ...db.prepare('SELECT * FROM export_nachweise').get() };
  assert.equal(jobVorher.debitor_id, lieferant);
  db.close();

  db = openDatabase(pfad);
  const tabellen = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
  assert.ok(tabellen.includes('kreditoren') && tabellen.includes('kreditor_ibans'));
  assert.ok(!tabellen.includes('debitoren') && !tabellen.includes('debitor_ibans'));
  assert.deepEqual(db.prepare('SELECT id, name, konto_id, aktiv FROM kreditoren ORDER BY id').all().map((r) => ({ ...r })), [
    { id: lieferant, name: 'Papier AG', konto_id: 1, aktiv: 1 }, { id: zweiter, name: 'Strom GmbH', konto_id: null, aktiv: 1 },
  ]);
  assert.equal(db.prepare('SELECT kreditor_id FROM kreditor_ibans').get().kreditor_id, lieferant);
  assert.equal(db.prepare('SELECT kreditor_id FROM zuweisungsregeln').get().kreditor_id, lieferant);
  // Job: only the column name changes; amounts, account, status, snapshot and hash stay identical.
  const jobNachher = { ...getJobById(db, jobId) };
  const { debitor_id: alterWert, ...restVorher } = jobVorher;
  const { kreditor_id: neuerWert, ...restNachher } = jobNachher;
  assert.equal(neuerWert, alterWert);
  assert.deepEqual(restNachher, restVorher);
  assert.equal(jobNachher.freigabe_snapshot, snapshot);
  assert.equal(sha(jobNachher.freigabe_snapshot), sha(snapshot));
  assert.deepEqual({ ...db.prepare('SELECT * FROM export_nachweise').get() }, exportVorher);
  // History is not rewritten: all earlier audit rows are byte-identical.
  assert.deepEqual(db.prepare('SELECT * FROM audit_ereignisse WHERE id <= ? ORDER BY id').all(auditVorher.at(-1).id).map((row) => ({ ...row })), auditVorher);
  // Historical snapshot is read through the explicit adapter.
  assert.equal(kreditorIdAusDatensatz(JSON.parse(jobNachher.freigabe_snapshot).job), lieferant);
  // Permission mapped, not dropped, and recorded.
  const person = { churchtools_person_id: '5', gruppen: [], aktiv: 1 };
  assert.equal(personHasPermission(db, { churchtools: {} }, person, 'kreditoren_verwalten'), true);
  const recht = db.prepare("SELECT nachher FROM audit_ereignisse WHERE aktion = 'recht_umbenannt'").get();
  assert.deepEqual(JSON.parse(recht.nachher), { von: 'debitoren_verwalten', nach: 'kreditoren_verwalten', personen: ['5'] });
  const migration = db.prepare("SELECT * FROM audit_ereignisse WHERE objekt = 'schema_migration'").all();
  assert.equal(migration.length, 1);
  assert.equal(JSON.parse(migration[0].nachher).anzahlKreditoren, 2);
  // Old trigger is gone; changes are audited exactly once under the new object name.
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'audit_debitor%'").get().n, 0);
  const vorUpdate = db.prepare('SELECT max(id) AS id FROM audit_ereignisse').get().id;
  db.prepare("UPDATE kreditoren SET name = 'Papier AG neu' WHERE id = ?").run(lieferant);
  assert.deepEqual(db.prepare('SELECT objekt, aktion FROM audit_ereignisse WHERE id > ?').all(vorUpdate).map((r) => ({ ...r })), [{ objekt: 'kreditoren', aktion: 'UPDATE' }]);
  db.close();

  // Restart: nothing is migrated twice, data unchanged.
  db = openDatabase(pfad);
  t.after(() => db.close());
  assert.equal(db.prepare("SELECT count(*) AS n FROM audit_ereignisse WHERE objekt = 'schema_migration' OR aktion = 'recht_umbenannt'").get().n, 2);
  assert.equal(getJobById(db, jobId).kreditor_id, lieferant);
  assert.equal(db.prepare("SELECT count(*) AS n FROM person_berechtigungen WHERE berechtigung = 'kreditoren_verwalten'").get().n, 1);
});

test('a database with both old and new tables refuses to start and is left untouched', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'kreditoren-konflikt-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pfad = join(dir, 'portal.sqlite');
  let db = openDatabase(pfad);
  createKreditor(db, { name: 'Neu AG', kontoId: null });
  db.exec('CREATE TABLE debitoren (id INTEGER PRIMARY KEY, name TEXT NOT NULL, konto_id INTEGER, aktiv INTEGER NOT NULL DEFAULT 1)');
  db.prepare("INSERT INTO debitoren (id, name) VALUES (1, 'Alt AG')").run();
  db.close();
  assert.throws(() => openDatabase(pfad), /existieren beide/);
  db = openDatabase(':memory:');
  db.close();
});

test('input adapter accepts new and legacy names and rejects contradicting values', () => {
  assert.equal(kreditorIdAusEingabe({ kreditorId: '4' }), '4');
  assert.equal(kreditorIdAusEingabe({ debitorId: '4' }), '4');
  assert.equal(kreditorIdAusEingabe({ kreditorId: '4', debitorId: '4' }), '4');
  assert.equal(kreditorIdAusEingabe({ kreditorId: '', debitorId: '' }), null);
  assert.throws(() => kreditorIdAusEingabe({ kreditorId: '4', debitorId: '5' }), KreditorFeldKonflikt);
  assert.equal(kreditorIdAusDatensatz({ kreditor_id: 3 }), 3);
  assert.equal(kreditorIdAusDatensatz({ debitor_id: 3 }), 3);
  assert.equal(kreditorIdAusDatensatz({}), null);
  assert.throws(() => kreditorIdAusDatensatz({ kreditor_id: 3, debitor_id: 4 }), KreditorFeldKonflikt);
  assert.deepEqual(kreditorNameVariablen('Papier AG'), { kreditorName: 'Papier AG', debitorName: 'Papier AG' });
});
