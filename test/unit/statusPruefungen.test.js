import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { seedDefaults, setConfigValue, getConfigValue } from '../../src/db/adminConfigRepo.js';
import {
  pruefeAlleDienste, pruefeSicherung, pruefeMailversand, pruefeChurchtools, pruefeZeitstempel,
  pruefeAuditNachweis, pruefeArchivuebergabe, pruefeSpeicher, pruefeJobs, pruefeSicherheitsalarme, pruefeDatenbank, pruefeEinrichtung, createStatusCache,
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

test('Sicherung: letzter Lauf fehlgeschlagen ohne bisherigen Erfolg ist Fehler', (t) => {
  const db = setup(t);
  cron(db, 'datenbank-sicherung', 'fehler', vor(1 * H));
  const r = pruefeSicherung(db, config, ctx());
  assert.equal(r.status, 'fehler');
  assert.equal(r.grund, 'Letzte Sicherung fehlgeschlagen');
});

test('Archivuebergabe: wartende Splitgruppen zaehlen', (t) => {
  const db = setup(t);
  db.prepare("INSERT INTO jobs (eingang_am, quelle, dateiname, pdf_pfad, status, gruppe_pdf_pfad, gruppe_zeitstempel_gesetzt_am) VALUES (?, 'scanner', 'g.pdf', '/x', 'aufgesplittet', '/g', ?)")
    .run(vor(10 * 24 * H), vor(3 * 24 * H));
  const r = pruefeArchivuebergabe(db, config, ctx());
  assert.equal(r.status, 'warnung');
  assert.equal(r.grund, '1 Beleg(e) zu lange nicht abgeholt (inkl. gesperrter Belege)');
  db.prepare("UPDATE jobs SET gruppe_abgeholt_am = ?").run(vor(H));
  assert.equal(pruefeArchivuebergabe(db, config, ctx()).status, 'ok');
});

test('Sicherung: letzter Lauf fehlgeschlagen nach Erfolg gibt Fehler', (t) => {
  const db = setup(t);
  cron(db, 'datenbank-sicherung', 'erfolg', vor(2 * H));
  cron(db, 'datenbank-sicherung', 'fehler', vor(1 * H));
  const r = pruefeSicherung(db, config, ctx());
  assert.equal(r.status, 'fehler');
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

test('Mailversand: Wiederholungen in 24 h warnen (eingereiht, versendet, Sammelmail)', (t) => {
  const ins = (db, status, versuche, fehler, versucht = vor(H)) => db.prepare(
    "INSERT INTO mail_log (typ, empfaenger, betreff, text, status, versucht_am, eingereiht_am, versuche, fehler_details) VALUES ('zuweisung', 'a@b.ch', 's', 't', ?, ?, ?, ?, ?)"
  ).run(status, versucht, versucht, versuche, fehler);
  const a = setup(t);
  ins(a, 'versendet', 1, null);
  ins(a, 'geplant', 0, null);
  assert.equal(pruefeMailversand(a, config, ctx()).status, 'ok');
  ins(a, 'eingereiht', 2, 'SMTP weg (Versuch 2 von 5)');
  const r = pruefeMailversand(a, config, ctx());
  assert.equal(r.status, 'warnung');
  assert.match(r.grund, /Fehlversuch/);
  const b = setup(t);
  ins(b, 'versendet', 2, null);
  assert.equal(pruefeMailversand(b, config, ctx()).status, 'warnung');
  const c = setup(t);
  ins(c, 'versendet', 3, null, vor(25 * H));
  assert.equal(pruefeMailversand(c, config, ctx()).status, 'ok');
  ins(c, 'geplant', 1, 'SMTP weg (Versuch 1 von 5)');
  assert.equal(pruefeMailversand(c, config, ctx()).status, 'warnung');
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

test('Jobs: Einträge älter als 7 Tage zählen nicht mehr', (t) => {
  const db = setup(t);
  cron(db, 'pool-erinnerungen', 'fehler', vor(7 * 24 * H + 1000));
  assert.equal(pruefeJobs(db, config, ctx()).status, 'ok');
  cron(db, 'pdf-bereinigung', 'fehler', vor(7 * 24 * H - 1000));
  const r = pruefeJobs(db, config, ctx());
  assert.equal(r.status, 'warnung');
  assert.match(r.grund, /pdf-bereinigung/);
  assert.doesNotMatch(r.grund, /pool-erinnerungen/);
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
  assert.deepEqual(Object.keys(r.dienste), ['datenbank', 'sicherung', 'mailversand', 'churchtools', 'zeitstempel', 'audit_nachweis', 'archivuebergabe', 'speicher', 'jobs', 'sicherheitsalarme', 'einrichtung']);
  // Frische Installation: nur die Ersteinrichtung warnt, alle übrigen Dienste sind in Ordnung.
  assert.equal(r.status, 'warnung');
  assert.deepEqual(Object.entries(r.dienste).filter(([, d]) => d.status !== 'ok').map(([k]) => k), ['einrichtung']);
  assert.equal(r.geprueft_am, T0.toISOString());
  cron(db, 'pdf-bereinigung', 'fehler', vor(H));
  assert.equal(pruefeAlleDienste(db, config, ctx()).status, 'warnung');
  db.prepare("INSERT INTO sicherheitsalarme (alarm_typ, schluessel, erkannt_am, naechster_versuch_am) VALUES ('backup_loeschung_offen', 'k', ?, ?)").run(vor(H), vor(H));
  r = pruefeAlleDienste(db, config, ctx());
  assert.equal(r.status, 'fehler');
});

test('Prüfung wirft: Dienst "Prüfung fehlgeschlagen" als Fehler, übrige laufen weiter', (t) => {
  const db = setup(t);
  db.exec('DROP TABLE sicherheitsalarme');
  const r = pruefeAlleDienste(db, config, ctx());
  assert.deepEqual(r.dienste.sicherheitsalarme, { status: 'fehler', grund: 'Prüfung fehlgeschlagen' });
  assert.equal(r.status, 'fehler');
  assert.equal(r.dienste.datenbank.status, 'ok');
  assert.equal(r.dienste.speicher.status, 'ok');
});

test('grund enthaelt keine Pfade oder URLs', (t) => {
  const db = setup(t);
  setConfigValue(db, 'zeitstempel_tsa_url', 'https://tsa.example.org/tsr');
  const r = pruefeAlleDienste(db, { ...config, tsaCrlFile: '/geheim/crl.pem' }, ctx({ tsaErgebnis: { erreichbar: false }, statfs: () => { throw new Error('/var/data kaputt'); } }));
  for (const d of Object.values(r.dienste)) assert.doesNotMatch(d.grund, /\/|https?:|\.sqlite|tsa\.example/);
});

test('Status-Cache: zwei Aufrufe innerhalb 30 s prüfen einmal, danach und mit neu=true erneut', () => {
  let laeufe = 0;
  let uhr = T0.getTime();
  let tsaAufrufe = 0;
  const cache = createStatusCache({
    db: {}, config,
    tsaErreichbarkeit: () => { tsaAufrufe++; return { erreichbar: true }; },
    pruefe: (db, cfg, { tsaErgebnis }) => { laeufe++; return { status: 'ok', geprueft_am: new Date(uhr).toISOString(), dienste: {}, tsaErgebnis }; },
    jetzt: () => uhr,
  });
  const a = cache.ergebnis();
  uhr += 29_999;
  const b = cache.ergebnis();
  assert.equal(laeufe, 1);
  assert.equal(tsaAufrufe, 1);
  assert.equal(a, b);
  assert.deepEqual(a.tsaErgebnis, { erreichbar: true });
  cache.ergebnis({ neu: true });
  assert.equal(laeufe, 2);
  uhr += 30_000;
  cache.ergebnis();
  assert.equal(laeufe, 3);
  cache.leeren();
  cache.ergebnis();
  assert.equal(laeufe, 4);
});

test('Status-Cache: TSA-Fehler blockiert die Prüfung nicht', () => {
  const cache = createStatusCache({ db: {}, config, tsaErreichbarkeit: () => { throw new Error('x'); }, pruefe: (db, cfg, o) => ({ status: 'ok', tsa: o.tsaErgebnis }) });
  assert.equal(cache.ergebnis().tsa, null);
});

test('Einrichtung: offene Pflichtschritte warnen mit Anzahl, Abschluss wird festgehalten und bleibt ok', (t) => {
  const db = setup(t);
  const cfg = { ...config, churchtools: { groupIdAdmin: '20' }, tsaTrustAnchorsFile: '/etc/tsa.pem', tsaTrustAnchorsSha256: 'a'.repeat(64) };
  const offen = pruefeEinrichtung(db, cfg, ctx({ technik: [] }));
  assert.equal(offen.status, 'warnung');
  assert.match(offen.grund, /^\d+ von 8 Pflichtschritten offen$/);

  db.prepare("INSERT INTO personen (churchtools_person_id, vorname, nachname, email, gruppen, aktiv) VALUES ('1', 'A', 'B', 'a@x.ch', '[\"20\"]', 1)").run();
  db.prepare("INSERT INTO personen (churchtools_person_id, vorname, nachname, email, gruppen, aktiv) VALUES ('2', 'C', 'D', 'c@x.ch', '[]', 1)").run();
  db.prepare("INSERT INTO sync_log (gestartet_am, beendet_am, status) VALUES (?, ?, 'erfolg')").run(vor(H), vor(H));
  db.prepare("INSERT INTO mail_log (typ, job_id, empfaenger, betreff, text, status, versucht_am) VALUES ('testmail', NULL, 'a@x.ch', 'B', 'T', 'versendet', ?)").run(vor(H));
  db.prepare("INSERT INTO konten (kontonummer, bezeichnung, freigeber1_id, stellvertreter1_id, freigeber2_id, stellvertreter2_id, aktiv) VALUES ('1000', 'K', '1', '1', '2', '2', 1)").run();
  setConfigValue(db, 'zeitstempel_tsa_url', 'https://tsa.example.org/tsr');
  cron(db, 'datenbank-sicherung', 'erfolg', vor(H));
  setConfigValue(db, 'betrieb_kontakt_email', 'it@x.ch');
  // Zeitstempeldienst gemeldet nicht erreichbar: Schritt zeitstempel bleibt offen.
  assert.equal(pruefeEinrichtung(db, cfg, ctx({ technik: [], tsaErgebnis: { erreichbar: false } })).grund, '1 von 8 Pflichtschritten offen');
  assert.equal(getConfigValue(db, 'einrichtung_abgeschlossen_am'), null);
  const fertig = pruefeEinrichtung(db, cfg, ctx({ technik: [] }));
  assert.deepEqual(fertig, { status: 'ok', aktiv: false, grund: 'Einrichtung abgeschlossen am 25.10.2026' });
  assert.equal(getConfigValue(db, 'einrichtung_abgeschlossen_am'), T0.toISOString());
  // Später wieder offener Schritt ändert nichts mehr am Statusdienst.
  db.prepare("DELETE FROM mail_log WHERE typ = 'testmail'").run();
  const spaeter = pruefeEinrichtung(db, cfg, ctx({ jetzt: new Date('2026-11-03T08:00:00Z'), technik: [] }));
  assert.deepEqual(spaeter, { status: 'ok', aktiv: false, grund: 'Einrichtung abgeschlossen am 25.10.2026' });
});

test('Status-Cache: tsaErgebnis() liefert die zwischengespeicherte TSA-Erreichbarkeit', () => {
  const cache = createStatusCache({ db: {}, config, tsaErreichbarkeit: () => ({ erreichbar: false }), pruefe: () => ({ status: 'ok' }) });
  assert.deepEqual(cache.tsaErgebnis(), { erreichbar: false });
  assert.equal(createStatusCache({ db: {}, config, pruefe: () => ({ status: 'ok' }) }).tsaErgebnis(), null);
  assert.equal(createStatusCache({ db: {}, config, tsaErreichbarkeit: () => { throw new Error('x'); }, pruefe: () => ({}) }).tsaErgebnis(), null);
});
