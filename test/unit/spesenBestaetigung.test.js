import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/db/index.js';
import { seedDefaults, setConfigValue } from '../../src/db/adminConfigRepo.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createJob } from '../../src/db/jobsRepo.js';
import { createSpesenabrechnung, listPositionen, setzeBestaetigung } from '../../src/db/spesenabrechnungenRepo.js';
import { listMailAnhaenge, listMailLog } from '../../src/db/mailLogRepo.js';
import {
  sichereBelegKopie, pruefeSpesenBestaetigung, holeSpesenBestaetigungenNach, abrechnungIdFuerJob,
} from '../../src/services/spesenBestaetigung.js';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const JETZT = Date.parse('2026-11-20T10:00:00Z');

function setup(t, { email = 'anna@example.org', titel = 'Lagerwochenende' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'spesen-bestaetigung-service-'));
  const db = openDatabase(':memory:');
  seedDefaults(db);
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const fehler = t.mock.method(console, 'error', () => {});
  upsertPerson(db, { id: '1', vorname: 'Anna', nachname: 'Muster', email, gruppen: [] });
  const config = { jobsDir: join(dir, 'jobs'), publicBaseUrl: 'https://portal.example.org' };
  mkdirSync(config.jobsDir);
  // 23:30 UTC ist in Zürich bereits der Folgetag.
  const abrechnungId = createSpesenabrechnung(db, { eingereichtVon: '1', eingereichtAm: '2026-11-01T23:30:00.000Z', titel });
  let nr = 0;
  // Position wie nach dem Workflow: Status direkt gesetzt; `versandt` legt Exportnachweis und Bexio-Versandquittung an.
  function position({ status = 'abgeschlossen', betrag = '10.00', beschreibung, versandt = false, exportiert = versandt, grund = null } = {}) {
    nr += 1;
    const pfad = join(config.jobsDir, `beleg-${nr}.pdf`);
    const bytes = Buffer.from(`%PDF-1.4\nbeleg ${nr}\n`);
    writeFileSync(pfad, bytes);
    const id = createJob(db, { eingangAm: '2026-11-01T00:00:00Z', quelle: 'spesen', dateiname: `quittung-${nr}.pdf`, pdfPfad: pfad });
    db.prepare(`UPDATE jobs SET status = ?, betrag = ?, beschreibung = ?, ablehnungsgrund = ?, spesenabrechnung_id = ?,
      eingereicht_von = '1', final_datei_hash = ? WHERE id = ?`)
      .run(status, betrag, beschreibung === undefined ? `Auslage ${nr}` : beschreibung, grund, abrechnungId, hash(bytes), id);
    if (exportiert) {
      db.prepare("INSERT INTO export_nachweise (id, job_id, sha256, manifest, erstellt_am) VALUES (?, ?, ?, '{}', '2026-11-02')").run(`e${id}`, id, hash(bytes));
    }
    if (versandt) versende(id);
    return { id, pfad, bytes };
  }
  function versende(id) {
    db.prepare(`INSERT INTO bexio_versand (job_id, export_id, empfaenger, message_id, smtp_antwort, gesendet_am, gemeldet_am)
      VALUES (?, ?, 'b@example.org', ?, '250', '2026-11-03', '2026-11-03')`).run(id, `e${id}`, `<m${id}>`);
  }
  const pruefe = () => pruefeSpesenBestaetigung(db, config, abrechnungId, { jetzt: JETZT });
  const stand = () => ({ ...db.prepare('SELECT bestaetigung_am, bestaetigung_vermerk FROM spesenabrechnungen WHERE id = ?').get(abrechnungId) });
  return { dir, db, config, abrechnungId, position, versende, pruefe, stand, fehler };
}

test('drei versandt → eine Mail mit drei Anhängen', (t) => {
  const s = setup(t);
  const a = s.position({ versandt: true, betrag: '0.10' });
  const b = s.position({ versandt: true, betrag: '0,20' });
  const c = s.position({ versandt: true, betrag: '42', beschreibung: null });
  const ergebnis = s.pruefe();
  assert.equal(ergebnis.ergebnis, 'eingereiht');
  const mails = listMailLog(s.db);
  assert.equal(mails.length, 1);
  const [mail] = mails;
  assert.equal(mail.id, ergebnis.mailId);
  assert.equal(mail.typ, 'spesen-bestaetigung');
  assert.equal(mail.status, 'eingereiht');
  assert.equal(mail.empfaenger, 'anna@example.org');
  assert.equal(mail.job_id, a.id);
  assert.match(mail.betreff, /Lagerwochenende/);
  assert.match(mail.text, /Hallo Anna Muster/);
  assert.match(mail.text, /vom 02\.11\.2026 ist freigegeben/);
  assert.match(mail.text, /- Auslage 1: CHF 0\.10\n- Auslage 2: CHF 0\.20\n- quittung-3\.pdf: CHF 42\.00\n/);
  assert.match(mail.text, /Total: CHF 42\.30\n/);
  assert.match(mail.text, /Belege findest du im Anhang/);
  assert.match(mail.text, /https:\/\/portal\.example\.org/);
  assert.doesNotMatch(mail.text, /Nicht freigegeben|%/);
  const anhaenge = listMailAnhaenge(s.db, ergebnis.mailId);
  assert.equal(anhaenge.length, 3);
  assert.deepEqual(anhaenge.map((x) => x.dateiname), [a, b, c].map((p) => `Spesen-${s.abrechnungId}-${p.id}.pdf`));
  assert.equal(anhaenge[0].pfad, join(s.config.jobsDir, 'mail-anhaenge', `spesen-${a.id}.pdf`));
  assert.equal(anhaenge[0].sha256, hash(a.bytes));
  assert.deepEqual(s.stand(), { bestaetigung_am: new Date(JETZT).toISOString(), bestaetigung_vermerk: 'versendet' });
});

test('zwei versandt + eine abgelehnt → Mail erwähnt Ablehnung mit Grund', (t) => {
  const s = setup(t);
  s.position({ versandt: true, betrag: '10.00' });
  s.position({ status: 'abgelehnt', betrag: '8', beschreibung: 'Parkgebühr', grund: 'Beleg\nunleserlich' });
  s.position({ versandt: true, betrag: '5.50' });
  s.position({ status: 'geloescht', betrag: '3.00', beschreibung: 'Doppelt', grund: 'zweimal erfasst' });
  const ergebnis = s.pruefe();
  assert.equal(ergebnis.ergebnis, 'eingereiht');
  const [mail] = listMailLog(s.db);
  assert.match(mail.text, /Nicht freigegeben:\n- Parkgebühr: CHF 8\.00 \(Grund: Beleg unleserlich\)\n- Doppelt: CHF 3\.00 \(gelöscht\)\n/);
  assert.match(mail.text, /Total: CHF 15\.50\n/);
  assert.equal(listMailAnhaenge(s.db, ergebnis.mailId).length, 2);
});

test('alle abgelehnt → keine Mail', (t) => {
  const s = setup(t);
  s.position({ status: 'abgelehnt', grund: 'nein' });
  s.position({ status: 'geloescht' });
  assert.deepEqual(s.pruefe(), { ergebnis: 'keine' });
  assert.equal(listMailLog(s.db).length, 0);
  assert.equal(s.stand().bestaetigung_vermerk, 'keine');
  assert.ok(s.stand().bestaetigung_am);
});

test('eine Position offen → offen', (t) => {
  const s = setup(t);
  s.position({ versandt: true });
  // Exportiert und abgeschlossen, aber ohne Versandquittung: weiterhin offen.
  s.position({ status: 'abgeschlossen', exportiert: true });
  assert.deepEqual(s.pruefe(), { ergebnis: 'offen' });
  assert.deepEqual(s.stand(), { bestaetigung_am: null, bestaetigung_vermerk: null });
  assert.equal(listMailLog(s.db).length, 0);
  assert.equal(s.db.isTransaction, false);
  // Schon versandte Positionen sind gesichert, bevor ihr Original gelöscht wird.
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM spesen_beleg_kopien').get().n, 1);
});

test('Abrechnung ohne Positionen oder unbekannte Abrechnung → offen', (t) => {
  const s = setup(t);
  assert.deepEqual(s.pruefe(), { ergebnis: 'offen' });
  assert.deepEqual(pruefeSpesenBestaetigung(s.db, s.config, 999), { ergebnis: 'offen' });
  assert.equal(s.stand().bestaetigung_am, null);
});

test('zweimal aufgerufen → eine Mail', (t) => {
  const s = setup(t);
  s.position({ versandt: true });
  assert.equal(s.pruefe().ergebnis, 'eingereiht');
  assert.deepEqual(s.pruefe(), { ergebnis: 'bereits' });
  assert.equal(listMailLog(s.db).length, 1);
});

test('innerhalb einer laufenden Transaktion wirft die Prüfung, ohne sie abzubrechen', (t) => {
  const s = setup(t);
  s.position({ versandt: true });
  s.db.exec('BEGIN IMMEDIATE');
  assert.throws(() => s.pruefe(), /transaction/i);
  assert.equal(s.db.isTransaction, true);
  s.db.exec('ROLLBACK');
  // Auch keine Dateiarbeit im Namen der fremden Transaktion.
  assert.equal(existsSync(join(s.config.jobsDir, 'mail-anhaenge')), false);
});

test('Fehler beim Einreihen setzt den Marker zurück', (t) => {
  const s = setup(t);
  s.position({ versandt: true });
  s.db.exec("CREATE TRIGGER mail_kaputt BEFORE INSERT ON mail_log BEGIN SELECT RAISE(ABORT, 'kaputt'); END");
  assert.throws(() => s.pruefe(), /kaputt/);
  assert.equal(s.db.isTransaction, false);
  assert.equal(s.stand().bestaetigung_am, null);
  // Die Beleg-Kopie entsteht vor der Transaktion und übersteht deren Abbruch.
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM spesen_beleg_kopien').get().n, 1);
  s.db.exec('DROP TRIGGER mail_kaputt');
  assert.equal(s.pruefe().ergebnis, 'eingereiht');
});

test('Original nach Bereinigung gelöscht → Anhang aus Kopie', (t) => {
  const s = setup(t);
  const p = s.position({ versandt: true });
  const kopie = sichereBelegKopie(s.db, s.config, p.id);
  assert.equal(kopie.sha256, hash(p.bytes));
  rmSync(p.pfad);
  const ergebnis = s.pruefe();
  const [anhang] = listMailAnhaenge(s.db, ergebnis.mailId);
  assert.equal(anhang.sha256, hash(p.bytes));
  assert.deepEqual(readFileSync(anhang.pfad), p.bytes);
});

test('Beleg-Kopie ist idempotent und überschreibt eine vorhandene Kopie nicht', (t) => {
  const s = setup(t);
  const p = s.position({ versandt: true });
  const erste = sichereBelegKopie(s.db, s.config, p.id);
  writeFileSync(p.pfad, 'nachträglich verändert');
  assert.deepEqual(sichereBelegKopie(s.db, s.config, p.id), erste);
  assert.deepEqual(readFileSync(erste.pfad), p.bytes);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM spesen_beleg_kopien').get().n, 1);
  assert.deepEqual(readdirSync(join(s.config.jobsDir, 'mail-anhaenge')), [`spesen-${p.id}.pdf`]);
});

test('verlorene Kopie-Datei wird aus dem unveränderten Original wiederhergestellt', (t) => {
  const s = setup(t);
  const p = s.position({ versandt: true });
  const erste = sichereBelegKopie(s.db, s.config, p.id);
  rmSync(erste.pfad);
  assert.deepEqual(sichereBelegKopie(s.db, s.config, p.id), erste);
  assert.deepEqual(readFileSync(erste.pfad), p.bytes);
});

test('keine Kopie ohne passenden Exportnachweis, für fremde Quellen oder fehlendes Original', (t) => {
  const s = setup(t);
  const ohneNachweis = s.position();
  assert.equal(sichereBelegKopie(s.db, s.config, ohneNachweis.id), null);
  const veraendert = s.position({ versandt: true });
  writeFileSync(veraendert.pfad, 'andere Bytes');
  assert.equal(sichereBelegKopie(s.db, s.config, veraendert.id), null);
  const weg = s.position({ versandt: true });
  rmSync(weg.pfad);
  assert.equal(sichereBelegKopie(s.db, s.config, weg.id), null);
  assert.equal(s.fehler.mock.callCount(), 3);
  const rechnung = s.position({ versandt: true });
  s.db.prepare("UPDATE jobs SET quelle = 'scanner' WHERE id = ?").run(rechnung.id);
  assert.equal(sichereBelegKopie(s.db, s.config, rechnung.id), null);
  assert.equal(sichereBelegKopie(s.db, s.config, 999), null);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM spesen_beleg_kopien').get().n, 0);
  assert.equal(existsSync(join(s.config.jobsDir, 'mail-anhaenge', `spesen-${veraendert.id}.pdf`)), false);
});

test('fehlende Kopie → Position ohne Anhang, Mail geht trotzdem mit Hinweis', (t) => {
  const s = setup(t);
  s.position({ versandt: true });
  const veraendert = s.position({ versandt: true });
  // Original ist noch da, lässt sich aber nicht kopieren (Hash weicht ab).
  writeFileSync(veraendert.pfad, 'andere Bytes');
  const ergebnis = s.pruefe();
  assert.equal(ergebnis.ergebnis, 'eingereiht');
  assert.equal(listMailAnhaenge(s.db, ergebnis.mailId).length, 1);
  const [mail] = listMailLog(s.db);
  assert.match(mail.text, /- Auslage 2: CHF 10\.00/);
  assert.match(mail.text, /Nicht alle Belege konnten angehängt werden/);
  assert.ok(s.fehler.mock.callCount() >= 1);
});

test('Kopie fehlt und Original schon gelöscht → keine Mail, Vermerk keine, Warnung', (t) => {
  const s = setup(t);
  const warnungen = t.mock.method(console, 'warn', () => {});
  s.position({ versandt: true });
  const weg = s.position({ versandt: true });
  rmSync(weg.pfad);
  assert.deepEqual(s.pruefe(), { ergebnis: 'keine' });
  assert.equal(listMailLog(s.db).length, 0);
  assert.deepEqual(s.stand(), { bestaetigung_am: new Date(JETZT).toISOString(), bestaetigung_vermerk: 'keine' });
  assert.equal(warnungen.mock.callCount(), 1);
  assert.match(warnungen.mock.calls[0].arguments[0], new RegExp(`Spesen-Bestätigung ${s.abrechnungId}:`));
  assert.deepEqual(s.pruefe(), { ergebnis: 'bereits' });
});

test('Kopie-Datei verloren und Original gelöscht → keine Mail', (t) => {
  const s = setup(t);
  t.mock.method(console, 'warn', () => {});
  const p = s.position({ versandt: true });
  rmSync(sichereBelegKopie(s.db, s.config, p.id).pfad);
  rmSync(p.pfad);
  assert.deepEqual(s.pruefe(), { ergebnis: 'keine' });
  assert.equal(listMailLog(s.db).length, 0);
});

test('Schalter aus → deaktiviert, keine Mail', (t) => {
  const s = setup(t);
  s.position({ versandt: true });
  setConfigValue(s.db, 'spesen_bestaetigung_aktiv', '0');
  assert.deepEqual(s.pruefe(), { ergebnis: 'deaktiviert' });
  assert.equal(s.stand().bestaetigung_vermerk, 'deaktiviert');
  assert.equal(listMailLog(s.db).length, 0);
});

test('Einreicher ohne Mailadresse → keine, kein Wurf', (t) => {
  const s = setup(t, { email: '' });
  s.position({ versandt: true });
  assert.deepEqual(s.pruefe(), { ergebnis: 'keine' });
  assert.equal(s.stand().bestaetigung_vermerk, 'keine');
  assert.equal(listMailLog(s.db).length, 0);
  assert.equal(s.fehler.mock.callCount(), 1);
});

test('Abrechnung ohne Titel wird mit ihrer Nummer benannt', (t) => {
  const s = setup(t, { titel: null });
  s.position({ versandt: true });
  s.pruefe();
  const [mail] = listMailLog(s.db);
  assert.match(mail.betreff, new RegExp(`«Nr\\. ${s.abrechnungId}»`));
});

for (const [name, groesse, anzahl] of [['genau 15 MB → Anhang', 15 * 1024 * 1024, 1], ['Anhänge über 15 MB → Mail ohne Anhänge mit Hinweis', 15 * 1024 * 1024 + 1, 0]]) {
  test(name, (t) => {
    const s = setup(t);
    const p = s.position({ versandt: true });
    const pfad = join(s.dir, 'gross.pdf');
    writeFileSync(pfad, Buffer.alloc(groesse));
    s.db.prepare('INSERT INTO spesen_beleg_kopien (job_id, pfad, sha256, erstellt_am) VALUES (?, ?, ?, ?)').run(p.id, pfad, 'stub', '2026-11-03');
    const ergebnis = s.pruefe();
    assert.equal(ergebnis.ergebnis, 'eingereiht');
    assert.equal(listMailAnhaenge(s.db, ergebnis.mailId).length, anzahl);
    const [mail] = listMailLog(s.db);
    if (anzahl) assert.match(mail.text, /Belege findest du im Anhang/);
    else assert.match(mail.text, /zu gross.*Finanzverwaltung/s);
    assert.equal(s.stand().bestaetigung_vermerk, 'versendet');
  });
}

test('Nachholen findet erledigte Abrechnung', (t) => {
  const s = setup(t);
  s.position({ versandt: true });
  createSpesenabrechnung(s.db, { eingereichtVon: '1', eingereichtAm: '2026-11-05T00:00:00Z', titel: 'offen' });
  assert.deepEqual(holeSpesenBestaetigungenNach(s.db, s.config), { geprueft: 2, eingereiht: 1 });
  assert.deepEqual(holeSpesenBestaetigungenNach(s.db, s.config), { geprueft: 1, eingereiht: 0 });
});

test('Nachholen: ein Fehler bei einer Abrechnung hält die übrigen nicht auf', (t) => {
  const s = setup(t);
  s.position({ versandt: true });
  const zweite = createSpesenabrechnung(s.db, { eingereichtVon: '1', eingereichtAm: '2026-11-05T00:00:00Z', titel: 'zweite' });
  const p = s.position({ versandt: true });
  s.db.prepare('UPDATE jobs SET spesenabrechnung_id = ? WHERE id = ?').run(zweite, p.id);
  s.db.exec(`CREATE TRIGGER mail_kaputt BEFORE INSERT ON mail_log WHEN NEW.betreff LIKE '%Lagerwochenende%' BEGIN SELECT RAISE(ABORT, 'kaputt'); END`);
  assert.deepEqual(holeSpesenBestaetigungenNach(s.db, s.config), { geprueft: 2, eingereiht: 1 });
  assert.equal(s.fehler.mock.callCount(), 1);
});

test('Repo: Positionen, bedingter Marker und Abrechnung zum Job', (t) => {
  const s = setup(t);
  const a = s.position();
  const b = s.position();
  assert.deepEqual(listPositionen(s.db, s.abrechnungId).map((j) => j.id), [a.id, b.id]);
  assert.equal(abrechnungIdFuerJob(s.db, a.id), s.abrechnungId);
  s.db.prepare("UPDATE jobs SET quelle = 'scanner' WHERE id = ?").run(b.id);
  assert.equal(abrechnungIdFuerJob(s.db, b.id), null);
  assert.equal(abrechnungIdFuerJob(s.db, 999), null);
  assert.equal(setzeBestaetigung(s.db, s.abrechnungId, 'keine', JETZT), true);
  assert.equal(setzeBestaetigung(s.db, s.abrechnungId, 'versendet', JETZT + 1000), false);
  assert.deepEqual(s.stand(), { bestaetigung_am: new Date(JETZT).toISOString(), bestaetigung_vermerk: 'keine' });
});
