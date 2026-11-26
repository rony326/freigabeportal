import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createSpesenabrechnung } from '../../src/db/spesenabrechnungenRepo.js';
import { reiheMailEin } from '../../src/services/mailZustellung.js';

// Spesen-Bestätigung: Spalten, Kopien-Tabelle, Mailtyp spesen-bestaetigung und die einmalige Altbestand-Markierung.
function tempPfad(t) {
  const dir = mkdtempSync(join(tmpdir(), 'spesen-bestaetigung-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'portal.db');
}

// Abrechnung mit je einem Job pro Eintrag; `versandt: true` legt Exportnachweis und Bexio-Versandquittung an.
function abrechnung(db, titel, positionen) {
  const id = Number(createSpesenabrechnung(db, { eingereichtVon: '1', eingereichtAm: '2026-01-01', titel }));
  for (const { status, versandt } of positionen) {
    const jobId = Number(db.prepare(`INSERT INTO jobs (eingang_am, quelle, dateiname, pdf_pfad, status, spesenabrechnung_id)
      VALUES ('2026-01-01', 'spesen', 'b.pdf', '/x/b.pdf', ?, ?)`).run(status, id).lastInsertRowid);
    if (versandt) versende(db, jobId);
  }
  return id;
}

function versende(db, jobId) {
  db.prepare("INSERT INTO export_nachweise (id, job_id, sha256, manifest, erstellt_am) VALUES (?, ?, 'h', '{}', '2026-01-01')").run(`e${jobId}`, jobId);
  db.prepare(`INSERT INTO bexio_versand (job_id, export_id, empfaenger, message_id, smtp_antwort, gesendet_am, gemeldet_am)
    VALUES (?, ?, 'b@example.org', ?, '250', '2026-01-01', '2026-01-01')`).run(jobId, `e${jobId}`, `<m${jobId}>`);
}

const stand = (db, id) => ({ ...db.prepare('SELECT bestaetigung_am, bestaetigung_vermerk FROM spesenabrechnungen WHERE id = ?').get(id) });

// Setzt eine Datenbankdatei auf den Stand vor der Änderung zurück.
function aufAltenStand(pfad, { ohneBexioVersand = false } = {}) {
  const raw = new DatabaseSync(pfad);
  raw.exec('PRAGMA foreign_keys = OFF');
  const sql = raw.prepare("SELECT sql FROM sqlite_master WHERE name = 'mail_log'").get().sql;
  const alt = sql.replace(", 'spesen-bestaetigung'", '').replace(/CREATE TABLE "?mail_log"?/, 'CREATE TABLE mail_log_neu');
  assert.ok(!alt.includes('spesen-bestaetigung'));
  raw.exec(alt);
  raw.exec('INSERT INTO mail_log_neu SELECT * FROM mail_log; DROP TABLE mail_log; ALTER TABLE mail_log_neu RENAME TO mail_log;');
  raw.exec('ALTER TABLE spesenabrechnungen DROP COLUMN bestaetigung_vermerk');
  raw.exec('ALTER TABLE spesenabrechnungen DROP COLUMN bestaetigung_am');
  raw.exec('DROP TABLE spesen_beleg_kopien');
  if (ohneBexioVersand) raw.exec('DROP TABLE bexio_versand');
  raw.close();
}

test('Migration markiert erledigte Altbestand-Abrechnungen, offene nicht', (t) => {
  const pfad = tempPfad(t);
  let db = openDatabase(pfad);
  upsertPerson(db, { id: '1', vorname: 'A', nachname: 'B', email: 'a@example.org', gruppen: [] });
  const erledigt = abrechnung(db, 'A', [{ status: 'abgeholt', versandt: true }, { status: 'abgelehnt' }, { status: 'geloescht' }]);
  const offen = abrechnung(db, 'B', [{ status: 'abgeholt', versandt: true }, { status: 'freigabe2' }]);
  const alleAbgelehnt = abrechnung(db, 'C', [{ status: 'abgelehnt' }]);
  const ohneQuittung = abrechnung(db, 'D', [{ status: 'abgeschlossen' }]);
  const ohnePositionen = abrechnung(db, 'E', []);
  // Vor dem Deployment abgeholt bzw. archiviert, aber n8n hat nie eine Versandquittung gemeldet: trotzdem Altbestand.
  const ohneMeldung = abrechnung(db, 'F', [{ status: 'archiviert' }, { status: 'abgeholt' }]);
  const teilsAbgeschlossen = abrechnung(db, 'G', [{ status: 'archiviert' }, { status: 'abgeschlossen' }]);
  reiheMailEin(db, { typ: 'zuweisung', jobId: null, empfaenger: 'a@example.org', betreff: 'b', text: 't' });
  db.close();
  aufAltenStand(pfad);

  const vorher = new Date().toISOString();
  db = openDatabase(pfad);
  for (const id of [erledigt, alleAbgelehnt, ohneMeldung]) {
    const zeile = stand(db, id);
    assert.equal(zeile.bestaetigung_vermerk, 'altbestand', `Abrechnung ${id}`);
    assert.ok(zeile.bestaetigung_am >= vorher, 'Zeitpunkt der Migration');
  }
  for (const id of [offen, ohneQuittung, ohnePositionen, teilsAbgeschlossen]) {
    assert.deepEqual(stand(db, id), { bestaetigung_am: null, bestaetigung_vermerk: null }, `Abrechnung ${id}`);
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM mail_log WHERE typ = 'zuweisung'").get().n, 1, 'bestehende Mail bleibt');
  const markiert = stand(db, erledigt);

  // Nach der Migration erledigte Abrechnungen sind kein Altbestand mehr, auch nicht beim nächsten Start.
  const letzte = db.prepare("SELECT id FROM jobs WHERE spesenabrechnung_id = ? AND status = 'freigabe2'").get(offen).id;
  db.prepare("UPDATE jobs SET status = 'abgeholt' WHERE id = ?").run(letzte);
  versende(db, letzte);
  db.close();
  db = openDatabase(pfad);
  assert.deepEqual(stand(db, offen), { bestaetigung_am: null, bestaetigung_vermerk: null });
  assert.deepEqual(stand(db, erledigt), markiert, 'Markierung bleibt unverändert');
  db.close();
});

test('Migration läuft auch auf einer Datenbank ohne bexio_versand', (t) => {
  const pfad = tempPfad(t);
  let db = openDatabase(pfad);
  upsertPerson(db, { id: '1', vorname: 'A', nachname: 'B', email: 'a@example.org', gruppen: [] });
  const abgelehnt = abrechnung(db, 'A', [{ status: 'abgelehnt' }]);
  const abgeschlossen = abrechnung(db, 'B', [{ status: 'abgeschlossen' }]);
  db.close();
  aufAltenStand(pfad, { ohneBexioVersand: true });
  db = openDatabase(pfad);
  assert.equal(stand(db, abgelehnt).bestaetigung_vermerk, 'altbestand');
  assert.equal(stand(db, abgeschlossen).bestaetigung_vermerk, null);
  db.close();
});

test('Neue Datenbank: nichts wird beim nächsten Start als Altbestand markiert', (t) => {
  const pfad = tempPfad(t);
  let db = openDatabase(pfad);
  upsertPerson(db, { id: '1', vorname: 'A', nachname: 'B', email: 'a@example.org', gruppen: [] });
  const id = abrechnung(db, 'A', [{ status: 'abgelehnt' }]);
  db.close();
  db = openDatabase(pfad);
  assert.deepEqual(stand(db, id), { bestaetigung_am: null, bestaetigung_vermerk: null });
  db.close();
});

test('bestaetigung_vermerk nur mit bekannten Werten; spesen_beleg_kopien ohne Fremdschlüssel', () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'A', nachname: 'B', email: 'a@example.org', gruppen: [] });
  const id = abrechnung(db, 'A', []);
  const setze = db.prepare('UPDATE spesenabrechnungen SET bestaetigung_vermerk = ? WHERE id = ?');
  for (const wert of ['versendet', 'keine', 'deaktiviert', 'altbestand']) assert.doesNotThrow(() => setze.run(wert, id));
  assert.throws(() => setze.run('quatsch', id), /CHECK/);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_list(spesen_beleg_kopien)').all(), []);
  assert.deepEqual(
    db.prepare('PRAGMA table_info(spesen_beleg_kopien)').all().map((c) => [c.name, c.type, c.notnull, c.pk]),
    [['job_id', 'INTEGER', 0, 1], ['pfad', 'TEXT', 1, 0], ['sha256', 'TEXT', 1, 0], ['erstellt_am', 'TEXT', 1, 0]],
  );
  db.close();
});

test('mail_log akzeptiert spesen-bestaetigung', () => {
  const db = openDatabase(':memory:');
  assert.doesNotThrow(() => reiheMailEin(db, { typ: 'spesen-bestaetigung', jobId: null, empfaenger: 'a@example.org', betreff: 'b', text: 't' }));
  db.close();
});
