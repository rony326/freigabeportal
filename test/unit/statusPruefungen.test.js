import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { seedDefaults, setConfigValue } from '../../src/db/adminConfigRepo.js';
import {
  pruefeAlleDienste, pruefeSicherung, pruefeMailversand, pruefeChurchtools, pruefeZeitstempel,
  pruefeAuditNachweis, pruefeArchivuebergabe, pruefeSpeicher, pruefeJobs, pruefeSicherheitsalarme, pruefeDatenbank,
} from '../../src/services/statusPruefungen.js';

const H = 3600 * 1000;
const T0 = new Date('2026-10-25T12:00:00.000Z');
const vor = (ms, von = T0) => new Date(von.getTime() - ms).toISOString();
const config = { dbPath: '/var/data/portal.sqlite', tsaCrlFile: null };
const ctx = (extra = {}) => ({ jetzt: T0, tsaErgebnis: null, statfs: () => ({ bavail: 50, blocks: 100 }), ...extra });

function setup(t) {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  seedDefaults(db);
  // Alte Installation, damit "noch kein Lauf" nicht greift
  db.prepare("INSERT INTO audit_ereignisse (zeitpunkt, person_id, person_name, objekt, objekt_id, aktion) VALUES (?, 'x', 'x', 'o', '1', 'a')").run(vor(400 * 24 * H));
  return db;
}
const cron = (db, job, status, beendet, gestartet = beendet) =>
  db.prepare('INSERT INTO cron_log (job, gestartet_am, beendet_am, status) VALUES (?, ?, ?, ?)').run(job, gestartet, beendet, status);

test('Datenbank: SELECT 1 ok, geschlossene DB fehler', (t) => {
  const db = openDatabase(':memory:');
  assert.equal(pruefeDatenbank(db, config, ctx()).status, 'ok');
  db.close();
  assert.equal(pruefeDatenbank(db, config, ctx()).status, 'fehler');
});

test('Sicherung: Grenzwerte 26 h / 50 h', (t) => {
  const db = setup(t);
  cron(db, 'datenbank-sicherung', 'erfolg', vor(26 * H));
  assert.equal(pruefeSicherung(db, config, ctx()).status, 'ok');
  assert.equal(pruefeSicherung(db, config, ctx({ jetzt: new Date(T0.getTime() + 1000) })).status, 'warnung');
  assert.equal(pruefeSicherung(db, config, ctx({ jetzt: new Date(T0.getTime() + 24 * H) })).status, 'warnung');
  assert.equal(pruefeSicherung(db, config, ctx({ jetzt: new Date(T0.getTime() + 24 * H + 1000) })).status, 'fehler');
  const r = pruefeSicherung(db, config, ctx());
  assert.equal(r.seit, vor(26 * H));
});

test('Sicherung: letzter Lauf fehlgeschlagen nach Erfolg gibt Warnung', (t) => {
  const db = setup(t);
  cron(db, 'datenbank-sicherung', 'erfolg', vor(2 * H));
  cron(db, 'datenbank-sicherung', 'fehler', vor(1 * H));
  const r = pruefeSicherung(db, config, ctx());
  assert.equal(r.status, 'warnung');
  assert.equal(r.seit, vor(2 * H));
});

test('Mailversand: Fehlversuche 24 h warnen, wartende Mails ueber Grenze fehlerhaft, geplant ignoriert', (t) => {
  const db = setup(t);
  const ins = (status, versucht, eingereiht) => db.prepare(
    "INSERT INTO mail_log (typ, empfaenger, betreff, text, status, versucht_am, eingereiht_am) VALUES ('zuweisung', 'a@b.ch', 's', 't', ?, ?, ?)"
  ).run(status, versucht, eingereiht);
  assert.equal(pruefeMailversand(db, config, ctx()).status, 'ok');
  ins('geplant', vor(100 * H), vor(100 * H));
  assert.equal(pruefeMailversand(db, config, ctx()).status, 'ok');
  ins('fehlgeschlagen', vor(25 * H), vor(25 * H));
  assert.equal(pruefeMailversand(db, config, ctx()).status, 'ok');
  ins('fehlgeschlagen', vor(24 * H), vor(24 * H));
  assert.equal(pruefeMailversand(db, config, ctx()).status, 'warnung');
  ins('eingereiht', vor(60 * 60000), vor(60 * 60000));
  assert.equal(pruefeMailversand(db, config, ctx()).status, 'warnung');
  ins('eingereiht', vor(61 * 60000), vor(61 * 60000));
  assert.equal(pruefeMailversand(db, config, ctx()).status, 'fehler');
});

test('ChurchTools: Grenzwerte 26 h / 50 h, Fehlschlag nach Erfolg warnt', (t) => {
  const db = setup(t);
  const sync = (status, beendet) => db.prepare('INSERT INTO sync_log (gestartet_am, beendet_am, status) VALUES (?, ?, ?)').run(beendet, beendet, status);
  sync('erfolg', vor(26 * H));
  assert.equal(pruefeChurchtools(db, config, ctx()).status, 'ok');
  assert.equal(pruefeChurchtools(db, config, ctx({ jetzt: new Date(T0.getTime() + 1000) })).status, 'warnung');
  assert.equal(pruefeChurchtools(db, config, ctx({ jetzt: new Date(T0.getTime() + 24 * H + 1000) })).status, 'fehler');
  sync('fehler', vor(1 * H));
  assert.equal(pruefeChurchtools(db, config, ctx()).status, 'warnung');
});

test('Zeitstempel: nicht eingerichtet, ueberfaellig warnt, TSA unerreichbar fehler', (t) => {
  const db = setup(t);
  assert.deepEqual(pruefeZeitstempel(db, config, ctx()), { status: 'ok', aktiv: false, grund: 'nicht eingerichtet' });
  setConfigValue(db, 'zeitstempel_tsa_url', 'https://tsa.example.org/tsr');
  assert.equal(pruefeZeitstempel(db, config, ctx()).status, 'ok');
  assert.equal(pruefeZeitstempel(db, config, ctx({ tsaErgebnis: { erreichbar: null } })).status, 'ok');
  assert.equal(pruefeZeitstempel(db, config, ctx({ tsaErgebnis: { erreichbar: false } })).status, 'fehler');
  db.prepare("INSERT INTO jobs (eingang_am, quelle, dateiname, pdf_pfad, status, abgeschlossen_am) VALUES (?, 'scanner', 'a.pdf', '/x', 'abgeschlossen', ?)")
    .run(vor(5 * H, new Date()), vor(5 * H, new Date()));
  assert.equal(pruefeZeitstempel(db, config, ctx()).status, 'warnung');
});

test('Zeitstempel: Sperrliste unlesbar warnt', (t) => {
  const db = setup(t);
  setConfigValue(db, 'zeitstempel_tsa_url', 'https://tsa.example.org/tsr');
  const r = pruefeZeitstempel(db, { ...config, tsaCrlFile: '/nicht/vorhanden.pem' }, ctx());
  assert.equal(r.status, 'warnung');
});

test('Zeitstempel: Sperrlisten-Ablauf an den Grenzen (7 Tage)', (t) => {
  const db = setup(t);
  setConfigValue(db, 'zeitstempel_tsa_url', 'https://tsa.example.org/tsr');
  const mk = (next) => () => [{ nextUpdate: { value: next } }];
  const z = (next) => pruefeZeitstempel(db, { ...config, tsaCrlFile: 'x' }, ctx({ ladeCrls: mk(next) }));
  assert.equal(z(new Date(T0.getTime() + 7 * 24 * H)).status, 'ok');
  assert.equal(z(new Date(T0.getTime() + 7 * 24 * H - 1000)).status, 'warnung');
  assert.equal(z(new Date(T0.getTime() - 1000)).status, 'fehler');
});

test('Audit-Nachweis: Modul aus, Paket ohne Zeitstempel warnt, aelter als Alarm-Tage fehler', (t) => {
  const db = setup(t);
  setConfigValue(db, 'modul_audit_nachweis_aktiv', '0');
  assert.deepEqual(pruefeAuditNachweis(db, config, ctx()), { status: 'ok', aktiv: false, grund: 'nicht eingerichtet' });
  setConfigValue(db, 'modul_audit_nachweis_aktiv', '1');
  assert.equal(pruefeAuditNachweis(db, config, ctx()).status, 'ok');
  const paket = (erstellt) => db.prepare(`INSERT INTO audit_export_pakete (von_id, bis_id, anzahl, luecken, inhalt_sha256, paket_sha256, erstellt_am)
    VALUES (1, 1, 1, '[]', ?, ?, ?)`).run('a'.repeat(64), 'b'.repeat(64), erstellt);
  paket(vor(3 * 24 * H));
  assert.equal(pruefeAuditNachweis(db, config, ctx()).status, 'warnung');
  assert.equal(pruefeAuditNachweis(db, config, ctx({ jetzt: new Date(T0.getTime() + 1000) })).status, 'fehler');
});

test('Archivuebergabe: 48 h Warnung, 7 Tage Fehler, Splitkinder ignoriert', (t) => {
  const db = setup(t);
  const job = (ab, split = null) => db.prepare("INSERT INTO jobs (eingang_am, quelle, dateiname, pdf_pfad, status, abgeschlossen_am, aufgesplittet_von) VALUES (?, 'scanner', 'a.pdf', '/x', 'abgeschlossen', ?, ?)").run(ab, ab, split);
  assert.equal(pruefeArchivuebergabe(db, config, ctx()).status, 'ok');
  const id = Number(job(vor(48 * H)).lastInsertRowid);
  assert.equal(pruefeArchivuebergabe(db, config, ctx()).status, 'ok');
  assert.equal(pruefeArchivuebergabe(db, config, ctx({ jetzt: new Date(T0.getTime() + 1000) })).status, 'warnung');
  job(vor(30 * 24 * H), id);
  assert.equal(pruefeArchivuebergabe(db, config, ctx()).status, 'ok');
  assert.equal(pruefeArchivuebergabe(db, config, ctx({ jetzt: new Date(T0.getTime() + 5 * 24 * H + 1000) })).status, 'fehler');
});

test('Speicher: 15 % / 5 % Grenzen, statfs-Fehler ist ok und inaktiv', (t) => {
  const db = setup(t);
  const s = (frei) => pruefeSpeicher(db, config, ctx({ statfs: () => ({ bavail: frei, blocks: 100 }) })).status;
  assert.equal(s(15), 'ok');
  assert.equal(s(14), 'warnung');
  assert.equal(s(5), 'warnung');
  assert.equal(s(4), 'fehler');
  const r = pruefeSpeicher(db, config, ctx({ statfs: () => { throw new Error('nein'); } }));
  assert.equal(r.status, 'ok');
  assert.equal(r.aktiv, false);
});

test('Jobs: letzter Lauf je Job, Fehler warnt mit Jobname', (t) => {
  const db = setup(t);
  cron(db, 'pdf-bereinigung', 'fehler', vor(5 * H));
  cron(db, 'pdf-bereinigung', 'erfolg', vor(4 * H));
  cron(db, 'mail-digest', 'erfolg', vor(3 * H));
  assert.equal(pruefeJobs(db, config, ctx()).status, 'ok');
  cron(db, 'mail-digest', 'fehler', vor(1 * H));
  const r = pruefeJobs(db, config, ctx());
  assert.equal(r.status, 'warnung');
  assert.match(r.grund, /mail-digest/);
  assert.doesNotMatch(r.grund, /pdf-bereinigung/);
});

test('Sicherheitsalarme: offen ist Fehler, erledigt nicht', (t) => {
  const db = setup(t);
  const al = (status) => db.prepare("INSERT INTO sicherheitsalarme (alarm_typ, schluessel, erkannt_am, status, naechster_versuch_am) VALUES ('backup_loeschung_offen', ?, ?, ?, ?)").run(String(Math.random()), vor(H), status, vor(H));
  assert.equal(pruefeSicherheitsalarme(db, config, ctx()).status, 'ok');
  al('erledigt');
  assert.equal(pruefeSicherheitsalarme(db, config, ctx()).status, 'ok');
  al('ausstehend');
  assert.equal(pruefeSicherheitsalarme(db, config, ctx()).status, 'fehler');
});

test('Grenzwerte aus admin_config ueberschreiben Defaults', (t) => {
  const db = setup(t);
  cron(db, 'datenbank-sicherung', 'erfolg', vor(10 * H));
  assert.equal(pruefeSicherung(db, config, ctx()).status, 'ok');
  setConfigValue(db, 'status_sicherung_warnung_stunden', '9');
  assert.equal(pruefeSicherung(db, config, ctx()).status, 'warnung');
  setConfigValue(db, 'status_sicherung_fehler_stunden', '10');
  assert.equal(pruefeSicherung(db, config, ctx({ jetzt: new Date(T0.getTime() + 1000) })).status, 'fehler');
});

test('frische Installation: vor Ablauf der Fehlergrenze ok "noch kein Lauf", danach Fehler', (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  seedDefaults(db);
  db.prepare("INSERT INTO audit_ereignisse (zeitpunkt, person_id, person_name, objekt, objekt_id, aktion) VALUES (?, 'x', 'x', 'o', '1', 'a')").run(vor(50 * H));
  const r = pruefeSicherung(db, config, ctx());
  assert.equal(r.status, 'ok');
  assert.equal(r.grund, 'noch kein Lauf');
  const spaet = pruefeSicherung(db, config, ctx({ jetzt: new Date(T0.getTime() + 1000) }));
  assert.equal(spaet.status, 'fehler');
  assert.equal(spaet.grund, 'noch nie erfolgreich');
  // ohne Audit-Ereignisse gilt jetzt als Installationsdatum
  const leer = openDatabase(':memory:');
  t.after(() => leer.close());
  seedDefaults(leer);
  assert.equal(pruefeChurchtools(leer, config, ctx()).grund, 'noch kein Lauf');
});

test('Gesamtstatus ist der schlechteste Dienst, alle Schluessel vorhanden', (t) => {
  const db = setup(t);
  cron(db, 'datenbank-sicherung', 'erfolg', vor(1 * H));
  db.prepare("INSERT INTO sync_log (gestartet_am, beendet_am, status) VALUES (?, ?, 'erfolg')").run(vor(H), vor(H));
  let r = pruefeAlleDienste(db, config, ctx());
  assert.deepEqual(Object.keys(r.dienste), ['datenbank', 'sicherung', 'mailversand', 'churchtools', 'zeitstempel', 'audit_nachweis', 'archivuebergabe', 'speicher', 'jobs', 'sicherheitsalarme']);
  assert.equal(r.status, 'ok');
  assert.equal(r.geprueft_am, T0.toISOString());
  cron(db, 'pdf-bereinigung', 'fehler', vor(H));
  assert.equal(pruefeAlleDienste(db, config, ctx()).status, 'warnung');
  db.prepare("INSERT INTO sicherheitsalarme (alarm_typ, schluessel, erkannt_am, naechster_versuch_am) VALUES ('backup_loeschung_offen', 'k', ?, ?)").run(vor(H), vor(H));
  r = pruefeAlleDienste(db, config, ctx());
  assert.equal(r.status, 'fehler');
});

test('grund enthaelt keine Pfade oder URLs', (t) => {
  const db = setup(t);
  setConfigValue(db, 'zeitstempel_tsa_url', 'https://tsa.example.org/tsr');
  const r = pruefeAlleDienste(db, { ...config, tsaCrlFile: '/geheim/crl.pem' }, ctx({ tsaErgebnis: { erreichbar: false }, statfs: () => { throw new Error('/var/data kaputt'); } }));
  for (const d of Object.values(r.dienste)) assert.doesNotMatch(d.grund, /\/|https?:|\.sqlite|tsa\.example/);
});
