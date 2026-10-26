import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { seedDefaults } from '../../src/db/adminConfigRepo.js';
import { createJob } from '../../src/db/jobsRepo.js';
import { createFreigabe } from '../../src/db/freigabenRepo.js';
import { upsertPerson } from '../../src/db/personenRepo.js';

// Task 3 / Integrität: die unveränderlichen Nachweis-Tabellen müssen UPDATE und DELETE auf
// Datenbankebene wirklich blockieren (nicht nur protokollieren), und die einmal gesetzten
// Unveränderlich-Spalten auf jobs dürfen sich nicht mehr ändern lassen.

function frischeDb() {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  return db;
}

function blockiert(db, sql, ...args) {
  assert.throws(() => db.prepare(sql).run(...args), /unveraenderlich|unveränderlich|nicht aufgehoben/i, `erwartet blockiert: ${sql}`);
}

test('audit_ereignisse ist append-only: UPDATE und DELETE werden abgewiesen', () => {
  const db = frischeDb();
  db.prepare("INSERT INTO audit_ereignisse (zeitpunkt, person_id, person_name, objekt, objekt_id, aktion) VALUES ('t','p','n','jobs','1','INSERT')").run();
  blockiert(db, "UPDATE audit_ereignisse SET aktion = 'X' WHERE id = 1");
  blockiert(db, 'DELETE FROM audit_ereignisse WHERE id = 1');
  db.close();
});

test('kommentare ist append-only: UPDATE und DELETE werden abgewiesen', () => {
  const db = frischeDb();
  const jid = createJob(db, { eingangAm: new Date().toISOString(), quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf', dateiHash: 'h1' });
  db.prepare("INSERT INTO kommentare (job_id, person_id, text, erwaehnt, erstellt_am) VALUES (?, 'p', 'hallo', '[]', 't')").run(jid);
  blockiert(db, "UPDATE kommentare SET text = 'manipuliert' WHERE job_id = ?", jid);
  blockiert(db, 'DELETE FROM kommentare WHERE job_id = ?', jid);
  db.close();
});

test('export_nachweise und archiv_quittungen sind append-only', () => {
  const db = frischeDb();
  const jid = createJob(db, { eingangAm: new Date().toISOString(), quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf', dateiHash: 'h1' });
  db.prepare("INSERT INTO export_nachweise (id, job_id, sha256, manifest, erstellt_am) VALUES ('e1', ?, 's', '{}', 't')").run(jid);
  db.prepare("INSERT INTO archiv_quittungen (export_id, dokument_id, task_id, sha256, bestaetigt_am) VALUES ('e1', 'd1', 'task', 's', 't')").run();
  blockiert(db, "UPDATE export_nachweise SET sha256 = 'x' WHERE id = 'e1'");
  blockiert(db, "DELETE FROM export_nachweise WHERE id = 'e1'");
  blockiert(db, "UPDATE archiv_quittungen SET sha256 = 'x' WHERE export_id = 'e1'");
  blockiert(db, "DELETE FROM archiv_quittungen WHERE export_id = 'e1'");
  db.close();
});

test('jobs: Zeitstempel-/Snapshot-/Final-Hash-Spalten sind nach dem Setzen unveränderlich', () => {
  const db = frischeDb();
  const jid = createJob(db, { eingangAm: new Date().toISOString(), quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf', dateiHash: 'h1' });
  db.prepare(`UPDATE jobs SET zeitstempel_datei_hash = 'abc', zeitstempel_gesetzt_am = 't',
    freigabe_snapshot = '{}', gruppe_final_datei_hash = 'g' WHERE id = ?`).run(jid);
  blockiert(db, "UPDATE jobs SET zeitstempel_datei_hash = 'def' WHERE id = ?", jid);
  blockiert(db, "UPDATE jobs SET zeitstempel_gesetzt_am = 'spaeter' WHERE id = ?", jid);
  blockiert(db, "UPDATE jobs SET freigabe_snapshot = '{\"x\":1}' WHERE id = ?", jid);
  blockiert(db, "UPDATE jobs SET gruppe_final_datei_hash = 'g2' WHERE id = ?", jid);
  db.close();
});

test('jobs: eine gesetzte Zeitstempelpflicht lässt sich nicht wieder aufheben', () => {
  const db = frischeDb();
  const jid = createJob(db, { eingangAm: new Date().toISOString(), quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf', dateiHash: 'h1' });
  db.prepare('UPDATE jobs SET zeitstempel_erforderlich = 1 WHERE id = ?').run(jid);
  blockiert(db, 'UPDATE jobs SET zeitstempel_erforderlich = 0 WHERE id = ?', jid);
  db.close();
});

// FUND T3-INT-1 (mittel, Nachvollziehbarkeit): Die Freigabe-Nachweise (freigaben) sind die
// Vier-Augen-Belege (wer hat Freigabe 1/2 erteilt, Interessenskonflikt, IP, Zeitpunkt). Jede
// andere Nachweis-Tabelle (kommentare, audit_ereignisse, export_nachweise, archiv_quittungen,
// tsa_nachweise, altfall_entscheidungen, datei_quarantaene, sicherheitsalarme, audit_export_*)
// ist per Blockier-Trigger append-only — freigaben nicht: eine UPDATE/DELETE wird nur
// protokolliert, nicht abgewiesen. Über die App ist das heute nicht erreichbar (freigabenRepo
// kennt nur INSERT/SELECT, grep findet kein UPDATE/DELETE), daher Defense-in-Depth-Lücke.
// Task 5 ergänzt die beiden Trigger (wie kommentare_no_update/_no_delete) und entfernt skip.
test('freigaben sollte wie jede andere Nachweis-Tabelle append-only sein (FUND T3-INT-1)', () => {
  const db = frischeDb();
  upsertPerson(db, { id: 'p1', vorname: 'Test', nachname: 'Person', email: 'p1@example.org', gruppen: [] });
  const jid = createJob(db, { eingangAm: new Date().toISOString(), quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf', dateiHash: 'h1' });
  createFreigabe(db, { jobId: jid, personId: 'p1', rolle: 'freigeber1', zeitpunkt: new Date().toISOString(), ip: '::1', interessenskonflikt: false, kommentar: null, eskaliertVon: null });
  blockiert(db, "UPDATE freigaben SET person_id = 'p2' WHERE job_id = ?", jid);
  blockiert(db, 'DELETE FROM freigaben WHERE job_id = ?', jid);
  db.close();
});
