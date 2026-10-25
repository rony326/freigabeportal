import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { seedDefaults, setConfigValue } from '../../src/db/adminConfigRepo.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { getConfigValue } from '../../src/db/adminConfigRepo.js';
import { SCHRITTE, einrichtungsStand, markiereSchritt, setzeOhneZeitstempel, mailErledigt, einrichtungAbgeschlossenAm, datumAnzeige } from '../../src/services/ersteinrichtung.js';

const CONFIG = { churchtools: { groupIdAdmin: '20' } };
const JETZT = new Date('2026-10-25T12:00:00Z');
const GUT = { pruefungen: [{ id: 'x', status: 'ok' }] };

function neu(t) {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  t.after(() => db.close());
  return db;
}
const stand = (db, technik = GUT) => einrichtungsStand(db, CONFIG, { jetzt: JETZT, technik });
const ok = (s, id) => s.schritte.find((x) => x.id === id).erledigt;
const person = (id, gruppen) => upsertPerson(db0, { id, vorname: 'a', nachname: 'b', email: `${id}@x.ch`, gruppen });
let db0;

test('Schritt-Reihenfolge und Pflicht-Flags', () => {
  assert.deepEqual(SCHRITTE.map((s) => [s.id, s.pflicht]), [
    ['grundlagen', true], ['rollen', true], ['churchtools', true], ['mail', true], ['konten', true],
    ['zeitstempel', true], ['sicherung', true], ['kontakt', true], ['branding', false], ['kreditoren', false],
    ['module', false], ['mailvorlagen', false], ['monitoring', false], ['jobs', false],
  ]);
});

test('frische Installation: alle Pflichtschritte offen', (t) => {
  const db = neu(t);
  const s = einrichtungsStand(db, CONFIG, { jetzt: JETZT });
  assert.equal(s.pflichtGesamt, 8);
  assert.equal(s.pflichtOffen, 8);
});

test('grundlagen: ohne Technik offen mit Hinweis, fehlt/ungültig offen, sonst erledigt', (t) => {
  const db = neu(t);
  const o = einrichtungsStand(db, CONFIG, { jetzt: JETZT }).schritte[0];
  assert.equal(o.erledigt, false);
  assert.equal(o.hinweis, 'noch nicht geprüft');
  assert.equal(ok(stand(db, { pruefungen: [{ status: 'warnung' }, { status: 'ok' }] }), 'grundlagen'), true);
  assert.equal(ok(stand(db, { pruefungen: [{ status: 'fehlt' }] }), 'grundlagen'), false);
  assert.equal(ok(stand(db, { pruefungen: [{ status: 'ungültig' }] }), 'grundlagen'), false);
});

test('rollen: nur aktiver Superadmin zählt', (t) => {
  const db = neu(t); db0 = db;
  assert.equal(ok(stand(db), 'rollen'), false);
  person('1', ['10']);
  assert.equal(ok(stand(db), 'rollen'), false);
  person('2', ['20']);
  assert.equal(ok(stand(db), 'rollen'), true);
  db.prepare("UPDATE personen SET aktiv = 0 WHERE churchtools_person_id = '2'").run();
  assert.equal(ok(stand(db), 'rollen'), false);
});

test('churchtools: letzter sync_log-Eintrag muss erfolg sein', (t) => {
  const db = neu(t);
  assert.equal(ok(stand(db), 'churchtools'), false);
  const ins = (st) => db.prepare('INSERT INTO sync_log (gestartet_am, beendet_am, status) VALUES (?, ?, ?)').run(JETZT.toISOString(), JETZT.toISOString(), st);
  ins('erfolg');
  assert.equal(ok(stand(db), 'churchtools'), true);
  ins('fehler');
  assert.equal(ok(stand(db), 'churchtools'), false);
  db.prepare("INSERT INTO sync_log (gestartet_am, status) VALUES (?, 'erfolg')").run(JETZT.toISOString());
  assert.equal(ok(stand(db), 'churchtools'), false);
});

test('mail: false ohne testmail-Zeile, true bei versendeter', (t) => {
  const db = neu(t);
  assert.equal(mailErledigt(db), false);
  const ins = (st) => db.prepare("INSERT INTO mail_log (typ, empfaenger, betreff, text, status, versucht_am) VALUES ('testmail', 'a@b.ch', 's', 't', ?, ?)").run(st, JETZT.toISOString());
  ins('fehlgeschlagen');
  assert.equal(ok(stand(db), 'mail'), false);
  ins('versendet');
  assert.equal(ok(stand(db), 'mail'), true);
});

test('konten: aktives Konto mit beiden Freigebern', (t) => {
  const db = neu(t); db0 = db;
  for (const i of ['1', '2', '3', '4']) person(i, []);
  const ins = (f1, f2, aktiv) => db.prepare('INSERT INTO konten (kontonummer, bezeichnung, freigeber1_id, stellvertreter1_id, freigeber2_id, stellvertreter2_id, aktiv) VALUES (?, ?, ?, ?, ?, ?, ?)').run('1000', 'K', f1, '3', f2, '4', aktiv);
  assert.equal(ok(stand(db), 'konten'), false);
  ins('1', '2', 0);
  assert.equal(ok(stand(db), 'konten'), false);
  ins('1', '2', 1);
  assert.equal(ok(stand(db), 'konten'), true);
});

test('zeitstempel: URL mit Vertrauensanker oder bewusster Verzicht', (t) => {
  const db = neu(t);
  assert.equal(ok(stand(db), 'zeitstempel'), false);
  setzeOhneZeitstempel(db, true);
  assert.equal(ok(stand(db), 'zeitstempel'), true);
  setzeOhneZeitstempel(db, false);
  assert.equal(ok(stand(db), 'zeitstempel'), false);
  setConfigValue(db, 'zeitstempel_tsa_url', 'http://tsa.example');
  // URL allein reicht nicht: ohne Vertrauensanker lassen sich Zeitstempel nicht prüfen.
  const ohneAnker = stand(db).schritte.find((x) => x.id === 'zeitstempel');
  assert.equal(ohneAnker.erledigt, false);
  assert.match(ohneAnker.hinweis, /Vertrauensanker fehlen/);
  const mitAnker = { ...CONFIG, tsaTrustAnchorsFile: '/etc/tsa.pem', tsaTrustAnchorsSha256: 'a'.repeat(64) };
  const mit = (tsaErgebnis) => einrichtungsStand(db, mitAnker, { jetzt: JETZT, technik: GUT, tsaErgebnis }).schritte.find((x) => x.id === 'zeitstempel');
  assert.equal(mit(undefined).erledigt, true);
  assert.equal(mit({ erreichbar: null }).erledigt, true);
  assert.equal(mit({ erreichbar: true }).erledigt, true);
  const weg = mit({ erreichbar: false });
  assert.equal(weg.erledigt, false);
  assert.match(weg.hinweis, /Zeitstempeldienst nicht erreichbar/);
  assert.equal(einrichtungsStand(db, { ...CONFIG, tsaTrustAnchorsFile: '/etc/tsa.pem' }, { jetzt: JETZT, technik: GUT }).schritte.find((x) => x.id === 'zeitstempel').erledigt, false);
});

test('sicherung: erfolg jünger als 7 Tage, sonst offen', (t) => {
  const db = neu(t);
  const ins = (st, ende) => db.prepare("INSERT INTO cron_log (job, gestartet_am, beendet_am, status) VALUES ('datenbank-sicherung', ?, ?, ?)").run(ende, ende, st);
  assert.equal(ok(stand(db), 'sicherung'), false);
  ins('erfolg', '2026-10-17T12:00:00Z');
  assert.equal(ok(stand(db), 'sicherung'), false);
  ins('erfolg', '2026-10-20T12:00:00Z');
  assert.equal(ok(stand(db), 'sicherung'), true);
  ins('fehler', '2026-10-25T03:00:00Z');
  ins('laufend', '2026-10-25T04:00:00Z');
  assert.equal(ok(stand(db), 'sicherung'), true);
});

test('kontakt, branding, monitoring aus admin_config', (t) => {
  const db = neu(t);
  assert.equal(ok(stand(db), 'kontakt'), false);
  assert.equal(ok(stand(db), 'monitoring'), false);
  setConfigValue(db, 'betrieb_kontakt_email', 'it@x.ch');
  setConfigValue(db, 'monitoring_secret', 'a'.repeat(64));
  const s = stand(db);
  assert.equal(ok(s, 'kontakt'), true);
  assert.equal(ok(s, 'monitoring'), true);
  setConfigValue(db, 'seiten_titel', '');
  assert.equal(ok(stand(db), 'branding'), false);
  setConfigValue(db, 'seiten_titel', 'Meine Kirche');
  assert.equal(ok(stand(db), 'branding'), true);
});

test('branding: Standardtitel zählt nicht, eigener Titel oder Logo schon', (t) => {
  const db = neu(t);
  assert.equal(getConfigValue(db, 'seiten_titel'), 'Freigabeportal');
  assert.equal(ok(stand(db), 'branding'), false);
  setConfigValue(db, 'seiten_titel', '  Freigabeportal ');
  assert.equal(ok(stand(db), 'branding'), false);
  setConfigValue(db, 'branding_logo_pfad', '/daten/branding/logo.png');
  assert.equal(ok(stand(db), 'branding'), true);
  setConfigValue(db, 'branding_logo_pfad', '');
  setConfigValue(db, 'branding_logo_dunkel_pfad', '/daten/branding/logo-dunkel.png');
  assert.equal(ok(stand(db), 'branding'), true);
});

test('rollen: nennt aktive Personen der Admin- und Manager-Gruppe, ohne E-Mail', (t) => {
  const db = neu(t); db0 = db;
  upsertPerson(db, { id: '1', vorname: 'Anna', nachname: 'Admin', email: 'anna@x.ch', gruppen: ['20'] });
  upsertPerson(db, { id: '2', vorname: 'Max', nachname: 'Manager', email: 'max@x.ch', gruppen: ['30'] });
  upsertPerson(db, { id: '3', vorname: 'Inge', nachname: 'Inaktiv', email: 'inge@x.ch', gruppen: ['20'] });
  db.prepare("UPDATE personen SET aktiv = 0 WHERE churchtools_person_id = '3'").run();
  const mitManager = { churchtools: { groupIdAdmin: '20', groupIdManager: '30' } };
  const r = einrichtungsStand(db, mitManager, { jetzt: JETZT, technik: GUT }).schritte.find((x) => x.id === 'rollen');
  assert.deepEqual(r.rollenPersonen, { admin: ['Anna Admin'], manager: ['Max Manager'] });
  assert.ok(!JSON.stringify(r).includes('@'));
  const ohne = stand(db).schritte.find((x) => x.id === 'rollen');
  assert.deepEqual(ohne.rollenPersonen, { admin: ['Anna Admin'], manager: null });
});

test('kreditoren: mindestens einer', (t) => {
  const db = neu(t);
  assert.equal(ok(stand(db), 'kreditoren'), false);
  db.prepare("INSERT INTO kreditoren (name) VALUES ('Lieferant')").run();
  assert.equal(ok(stand(db), 'kreditoren'), true);
});

test('module/mailvorlagen von Hand; nicht-manuelle IDs abgelehnt', (t) => {
  const db = neu(t);
  markiereSchritt(db, 'module', true);
  assert.equal(ok(stand(db), 'module'), true);
  assert.equal(ok(stand(db), 'mailvorlagen'), false);
  markiereSchritt(db, 'module', false);
  assert.equal(ok(stand(db), 'module'), false);
  assert.throws(() => markiereSchritt(db, 'konten', true));
  assert.throws(() => markiereSchritt(db, 'unbekannt', true));
});

test('jobs: Sync und Pool-Erinnerungen gelaufen (mail-zustellung nicht nötig)', (t) => {
  const db = neu(t);
  const cron = (j) => db.prepare("INSERT INTO cron_log (job, gestartet_am, beendet_am, status) VALUES (?, ?, ?, 'erfolg')").run(j, JETZT.toISOString(), JETZT.toISOString());
  db.prepare('INSERT INTO sync_log (gestartet_am, status) VALUES (?, ?)').run(JETZT.toISOString(), 'erfolg');
  assert.equal(ok(stand(db), 'jobs'), false);
  cron('pool-erinnerungen');
  assert.equal(ok(stand(db), 'jobs'), true);
});

test('Zählung pflichtOffen sinkt mit erledigten Pflichtschritten', (t) => {
  const db = neu(t);
  setzeOhneZeitstempel(db, true);
  setConfigValue(db, 'betrieb_kontakt_email', 'it@x.ch');
  const s = stand(db);
  assert.equal(s.pflichtGesamt, 8);
  assert.equal(s.pflichtOffen, 5); // grundlagen ist mit GUT erledigt
});

// Alle Pflichtschritte erledigen (Zeitstempel per Verzicht).
function allesErledigt(db) {
  const jetzt = JETZT.toISOString();
  upsertPerson(db, { id: '1', vorname: 'A', nachname: 'B', email: 'a@x.ch', gruppen: ['20'] });
  upsertPerson(db, { id: '2', vorname: 'C', nachname: 'D', email: 'c@x.ch', gruppen: [] });
  db.prepare("INSERT INTO sync_log (gestartet_am, beendet_am, status) VALUES (?, ?, 'erfolg')").run(jetzt, jetzt);
  db.prepare("INSERT INTO mail_log (typ, empfaenger, betreff, text, status, versucht_am) VALUES ('testmail', 'a@x.ch', 's', 't', 'versendet', ?)").run(jetzt);
  db.prepare("INSERT INTO konten (kontonummer, bezeichnung, freigeber1_id, stellvertreter1_id, freigeber2_id, stellvertreter2_id, aktiv) VALUES ('1000', 'K', '1', '1', '2', '2', 1)").run();
  setzeOhneZeitstempel(db, true);
  db.prepare("INSERT INTO cron_log (job, gestartet_am, beendet_am, status) VALUES ('datenbank-sicherung', ?, ?, 'erfolg')").run(jetzt, jetzt);
  setConfigValue(db, 'betrieb_kontakt_email', 'it@x.ch');
}

test('Abschluss wird einmalig festgehalten und bleibt, auch wenn ein Schritt später wieder offen ist', (t) => {
  const db = neu(t);
  assert.equal(stand(db).abgeschlossenAm, null);
  assert.equal(einrichtungAbgeschlossenAm(db), null);
  allesErledigt(db);
  const s = stand(db);
  assert.equal(s.pflichtOffen, 0);
  assert.equal(s.abgeschlossenAm, JETZT.toISOString());
  assert.equal(getConfigValue(db, 'einrichtung_abgeschlossen_am'), JETZT.toISOString());
  // Zweiter Aufruf später überschreibt den Zeitpunkt nicht.
  einrichtungsStand(db, CONFIG, { jetzt: new Date('2026-11-01T00:00:00Z'), technik: GUT });
  assert.equal(getConfigValue(db, 'einrichtung_abgeschlossen_am'), JETZT.toISOString());
  db.prepare("DELETE FROM mail_log WHERE typ = 'testmail'").run();
  const danach = stand(db);
  assert.equal(danach.pflichtOffen, 1);
  assert.equal(ok(danach, 'mail'), false); // die Seite zeigt weiter den echten Stand
  assert.equal(danach.abgeschlossenAm, JETZT.toISOString());
});

test('datumAnzeige: TT.MM.JJJJ in Europe/Zurich', () => {
  assert.equal(datumAnzeige('2026-10-25T12:00:00Z'), '25.10.2026');
  assert.equal(datumAnzeige('2026-12-31T23:30:00Z'), '01.01.2027');
});
