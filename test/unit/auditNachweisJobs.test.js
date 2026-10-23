import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { seedDefaults, setConfigValue, getConfigValue } from '../../src/db/adminConfigRepo.js';
import {
  runAuditExportJob, listPaketeOhneZeitstempel, ladeAuditZeitstempel, parseEmpfaengerListe, formatierePruefnummer,
  sendeAuditPruefnummer, istVersandtag, runAuditPruefnummerJob, meldeAuditNachweisAenderung, meldeAuditEmpfaengerWechsel,
} from '../../src/services/auditNachweisJobs.js';

const TAG = 24 * 3600 * 1000;
const T0 = new Date('2026-10-01T03:15:00.000Z');
const config = { publicBaseUrl: 'https://portal.example.org' };

function setup(t, { tsa = true } = {}) {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  seedDefaults(db);
  setConfigValue(db, 'sicherheitsalarm_empfaenger', 'alarm@example.org');
  if (tsa) setConfigValue(db, 'zeitstempel_tsa_url', 'https://tsa.example.org/tsr');
  const mails = [];
  return { db, mails, mailer: { async sendMail(mail) { mails.push(mail); } } };
}

function ereignis(db) {
  db.prepare(`INSERT INTO audit_ereignisse (zeitpunkt, person_id, person_name, objekt, objekt_id, aktion, nachher)
    VALUES ('2026-09-29T00:00:00Z', 'system', 'System', 'test', '1', 'test', '{}')`).run();
}

const okStempel = (hashes = []) => async (hash) => {
  hashes.push(hash);
  return { token: Buffer.from('x'), genTime: T0, nachweis: {} };
};
const failStempel = async () => { throw new Error('TSA nicht erreichbar'); };
const alarmMails = (db) => db.prepare("SELECT * FROM mail_log WHERE typ = 'sicherheitsalarm'").all();

test('erzeugt Pakete bis keine Ereignisse mehr ausstehen und stempelt sie', async (t) => {
  const { db, mailer } = setup(t);
  ereignis(db);
  const r1 = await runAuditExportJob(db, config, mailer, { jetzt: T0, stemple: okStempel() });
  assert.equal(r1.status, 'erfolg');
  assert.ok(r1.neuePakete >= 1);
  assert.equal(r1.gestempelt, r1.neuePakete);
  assert.equal(r1.ohneZeitstempel, 0);
  ereignis(db);
  const r2 = await runAuditExportJob(db, config, mailer, { jetzt: new Date(T0.getTime() + TAG), stemple: okStempel() });
  assert.ok(r2.neuePakete >= 1);
  assert.deepEqual(listPaketeOhneZeitstempel(db), []);
  const zeile = ladeAuditZeitstempel(db, 1);
  assert.equal(zeile.paket_nr, 1);
  assert.equal(zeile.gen_time, T0.toISOString());
});

test('ohne TSA-Konfiguration: Pakete ja, Stempel nein, status erfolg', async (t) => {
  const { db, mailer } = setup(t, { tsa: false });
  ereignis(db);
  let aufrufe = 0;
  const r = await runAuditExportJob(db, config, mailer, { jetzt: T0, stemple: async () => { aufrufe += 1; } });
  assert.equal(r.status, 'erfolg');
  assert.ok(r.neuePakete >= 1);
  assert.equal(aufrufe, 0);
  assert.equal(r.gestempelt, 0);
  assert.equal(r.ohneZeitstempel, r.neuePakete);
});

test('TSA-Fehler: Paket bleibt registriert, nächster Lauf holt in Reihenfolge nach', async (t) => {
  const { db, mailer } = setup(t);
  ereignis(db);
  const r1 = await runAuditExportJob(db, config, mailer, { jetzt: T0, stemple: failStempel });
  assert.equal(r1.status, 'fehler');
  assert.equal(r1.ohneZeitstempel, 1);
  assert.match(r1.error, /TSA nicht erreichbar/);
  const hashes = [];
  const r2 = await runAuditExportJob(db, config, mailer, { jetzt: new Date(T0.getTime() + 60000), stemple: okStempel(hashes) });
  assert.equal(r2.status, 'erfolg');
  assert.equal(r2.ohneZeitstempel, 0);
  const pakete = db.prepare('SELECT id, paket_sha256 FROM audit_export_pakete ORDER BY id').all();
  assert.deepEqual(hashes, pakete.map((p) => p.paket_sha256));
  assert.equal(db.prepare('SELECT count(*) AS n FROM audit_export_zeitstempel').get().n, pakete.length);
});

test('nach erstem TSA-Fehler im Lauf keine weiteren Versuche in diesem Lauf', async (t) => {
  const { db, mailer } = setup(t);
  for (let i = 0; i < 3; i++) {
    ereignis(db);
    await runAuditExportJob(db, config, mailer, { jetzt: T0, stemple: failStempel });
  }
  assert.ok(listPaketeOhneZeitstempel(db).length >= 3);
  let aufrufe = 0;
  const r = await runAuditExportJob(db, config, mailer, { jetzt: T0, stemple: async () => { aufrufe += 1; throw new Error('x'); } });
  assert.equal(aufrufe, 1);
  assert.equal(r.status, 'fehler');
});

test('abgeschaltet → uebersprungen, kein Paket, kein Stempel, kein Alarm', async (t) => {
  const { db, mailer } = setup(t);
  ereignis(db);
  await runAuditExportJob(db, config, mailer, { jetzt: T0, stemple: failStempel });
  setConfigValue(db, 'modul_audit_nachweis_aktiv', '0');
  const pakete = db.prepare('SELECT count(*) AS n FROM audit_export_pakete').get().n;
  let aufrufe = 0;
  ereignis(db);
  const r = await runAuditExportJob(db, config, mailer, { jetzt: new Date(T0.getTime() + 30 * TAG), stemple: async () => { aufrufe += 1; } });
  assert.deepEqual(r, { status: 'uebersprungen' });
  assert.equal(aufrufe, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM audit_export_pakete').get().n, pakete);
  assert.equal(alarmMails(db).length, 0);
  setConfigValue(db, 'modul_audit_nachweis_aktiv', '1');
  const r2 = await runAuditExportJob(db, config, mailer, { jetzt: new Date(T0.getTime() + 31 * TAG), stemple: okStempel() });
  assert.ok(r2.neuePakete >= 1);
  const letztes = db.prepare('SELECT * FROM audit_export_pakete ORDER BY id DESC LIMIT 1').get();
  assert.ok(letztes.anzahl >= 1);
});

async function altesPaketOhneStempel(t) {
  const s = setup(t);
  ereignis(s.db);
  await runAuditExportJob(s.db, config, s.mailer, { jetzt: T0, stemple: failStempel });
  return s;
}

test('Alarm, wenn ältestes Paket > 3 Tage ohne Zeitstempel (Default)', async (t) => {
  const { db, mailer } = await altesPaketOhneStempel(t);
  const r = await runAuditExportJob(db, config, mailer, { jetzt: new Date(T0.getTime() + 3 * TAG + 60000), stemple: failStempel });
  assert.equal(r.alarmiert, true);
  const mails = alarmMails(db);
  assert.equal(mails.length, 1);
  assert.match(mails[0].text, /Paketnummer 1\b/);
  assert.match(mails[0].text, /https:\/\/portal\.example\.org\/admin\/zeitstempel/);
});

test('kein Alarm bei 2 Tagen Rückstand', async (t) => {
  const { db, mailer } = await altesPaketOhneStempel(t);
  const r = await runAuditExportJob(db, config, mailer, { jetzt: new Date(T0.getTime() + 2 * TAG), stemple: failStempel });
  assert.equal(r.alarmiert, false);
  assert.equal(alarmMails(db).length, 0);
});

test('Alarmschwelle aus Konfiguration', async (t) => {
  const { db, mailer } = await altesPaketOhneStempel(t);
  setConfigValue(db, 'audit_zeitstempel_alarm_tage', '5');
  const r4 = await runAuditExportJob(db, config, mailer, { jetzt: new Date(T0.getTime() + 4 * TAG), stemple: failStempel });
  assert.equal(r4.alarmiert, false);
  const r5 = await runAuditExportJob(db, config, mailer, { jetzt: new Date(T0.getTime() + 5 * TAG + 60000), stemple: failStempel });
  assert.equal(r5.alarmiert, true);
});

test('Alarm höchstens alle 24 h', async (t) => {
  const { db, mailer } = await altesPaketOhneStempel(t);
  const t1 = T0.getTime() + 4 * TAG;
  assert.equal((await runAuditExportJob(db, config, mailer, { jetzt: new Date(t1), stemple: failStempel })).alarmiert, true);
  assert.equal((await runAuditExportJob(db, config, mailer, { jetzt: new Date(t1 + 3600000), stemple: failStempel })).alarmiert, false);
  assert.equal((await runAuditExportJob(db, config, mailer, { jetzt: new Date(t1 + 25 * 3600000), stemple: failStempel })).alarmiert, true);
  assert.equal(alarmMails(db).length, 2);
  assert.equal(getConfigValue(db, 'audit_zeitstempel_alarm_gesendet_am'), new Date(t1 + 25 * 3600000).toISOString());
});

// --- Prüfnummer-Mail ---
async function mitPaket(t, opts) {
  const s = setup(t, opts);
  setConfigValue(s.db, 'audit_revision_empfaenger', 'rev1@example.org, rev2@example.org');
  s.db.prepare(`INSERT INTO audit_ereignisse (zeitpunkt, person_id, person_name, objekt, objekt_id, aktion, nachher)
    VALUES ('2026-09-29T08:30:00Z', 'p1', 'Erika Muster', 'test', '1', 'test', '{}')`).run();
  await runAuditExportJob(s.db, config, s.mailer, { jetzt: T0, stemple: okStempel() });
  s.db.prepare('DELETE FROM mail_log').run();
  s.mails.length = 0;
  return s;
}
const pruefMails = (db) => db.prepare("SELECT * FROM mail_log WHERE typ = 'audit-pruefnummer' ORDER BY id").all();

test('sendet Prüfnummer an alle Empfänger mit Link zur Prüfseite', async (t) => {
  const { db, mailer, mails } = await mitPaket(t);
  const paket = db.prepare('SELECT * FROM audit_export_pakete ORDER BY id DESC LIMIT 1').get();
  const r = await sendeAuditPruefnummer(db, config, mailer);
  assert.deepEqual(r, { status: 'versendet', paketNr: paket.id, empfaenger: 2 });
  assert.equal(mails.length, 2);
  const text = mails[0].text;
  assert.match(text, new RegExp(formatierePruefnummer(paket.paket_sha256)));
  assert.ok(text.includes(`https://portal.example.org/audit-pruefen?paket=${paket.id}&pruefnummer=${paket.paket_sha256}`));
  assert.match(text, /Zeitraum: \d\d\.\d\d\.\d{4} \d\d:\d\d bis \d\d\.\d\d\.\d{4} \d\d:\d\d/);
  assert.doesNotMatch(text, /Erika/);
  assert.equal(getConfigValue(db, 'audit_pruefnummer_zuletzt_monat') ?? '', '');
});

test('kein_empfaenger und kein_paket versenden nichts', async (t) => {
  const { db, mailer, mails } = setup(t);
  assert.deepEqual(await sendeAuditPruefnummer(db, config, mailer), { status: 'kein_empfaenger' });
  setConfigValue(db, 'audit_revision_empfaenger', 'rev@example.org');
  assert.deepEqual(await sendeAuditPruefnummer(db, config, mailer), { status: 'kein_paket' });
  assert.equal(mails.length, 0);
});

test('ohneZeitstempel und zeitstempelZeit im Text', async (t) => {
  const mit = await mitPaket(t);
  await sendeAuditPruefnummer(mit.db, config, mit.mailer);
  assert.match(mit.mails[0].text, /Zeitstempel: 01\.10\.2026 05:15/);
  assert.match(mit.mails[0].text, /ohne Zeitstempel: 0/);
  const ohne = await mitPaket(t, { tsa: false });
  await sendeAuditPruefnummer(ohne.db, config, ohne.mailer);
  assert.match(ohne.mails[0].text, /Zeitstempel: noch keiner/);
  assert.match(ohne.mails[0].text, /ohne Zeitstempel: 1/);
});

test('Monatsjob sendet am 1. genau einmal', async (t) => {
  const { db, mailer, mails } = await mitPaket(t);
  const lauf = (iso) => runAuditPruefnummerJob(db, config, mailer, { jetzt: new Date(iso) });
  assert.equal((await lauf('2026-11-01T06:00:00Z')).status, 'erfolg');
  assert.equal(mails.length, 2);
  assert.equal((await lauf('2026-11-01T06:30:00Z')).status, 'uebersprungen');
  assert.equal((await lauf('2026-11-02T06:00:00Z')).status, 'uebersprungen');
  assert.equal((await lauf('2026-12-01T06:00:00Z')).status, 'erfolg');
  assert.equal(mails.length, 4);
  assert.equal(getConfigValue(db, 'audit_pruefnummer_zuletzt_monat'), '2026-12');
});

test('istVersandtag: Rhythmus, Tag und Zürcher Mitternacht', () => {
  assert.equal(istVersandtag(new Date('2027-04-15T10:00:00Z'), { rhythmus: 'quartalsweise', tag: 15 }), true);
  assert.equal(istVersandtag(new Date('2027-05-15T10:00:00Z'), { rhythmus: 'quartalsweise', tag: 15 }), false);
  assert.equal(istVersandtag(new Date('2027-01-01T10:00:00Z'), { rhythmus: 'jaehrlich', tag: 1 }), true);
  assert.equal(istVersandtag(new Date('2027-02-01T10:00:00Z'), { rhythmus: 'jaehrlich', tag: 1 }), false);
  assert.equal(istVersandtag(new Date('2026-10-31T23:30:00Z'), { rhythmus: 'monatlich', tag: 1 }), true);
  assert.equal(istVersandtag(new Date('2026-10-31T22:30:00Z'), { rhythmus: 'monatlich', tag: 1 }), false);
});

test('abgeschaltet: kein Versand am Versandtag', async (t) => {
  const { db, mailer, mails } = await mitPaket(t);
  setConfigValue(db, 'modul_audit_nachweis_aktiv', '0');
  const r = await runAuditPruefnummerJob(db, config, mailer, { jetzt: new Date('2026-11-01T06:00:00Z') });
  assert.equal(r.status, 'uebersprungen');
  assert.equal(mails.length, 0);
});

test('meldeAuditNachweisAenderung: eine Mail pro Empfänger mit allen Zeilen', async (t) => {
  const { db, mailer, mails } = await mitPaket(t);
  await meldeAuditNachweisAenderung(db, config, mailer, {
    aenderungen: ['Automatischer Nachweis: aktiv → abgeschaltet', 'Rhythmus: monatlich → jaehrlich'],
    person: { vorname: 'Anna', nachname: 'Admin' },
  });
  assert.equal(mails.length, 2);
  assert.equal(mails[0].subject, 'Freigabeportal: Einstellungen des Audit-Nachweises geändert');
  assert.match(mails[0].text, /aktiv → abgeschaltet/);
  assert.match(mails[0].text, /monatlich → jaehrlich/);
  assert.match(mails[0].text, /Anna Admin/);
  assert.equal(pruefMails(db).length, 2);
});

test('Empfängerwechsel geht an alte und neue Adresse', async (t) => {
  const { db, mailer, mails } = setup(t);
  await meldeAuditEmpfaengerWechsel(db, config, mailer, { alt: 'alt@example.org', neu: 'neu@example.org', person: { vorname: 'Anna', nachname: 'Admin' } });
  assert.equal(mails.length, 2);
  assert.deepEqual(mails.map((m) => m.to).sort(), ['alt@example.org', 'neu@example.org']);
  assert.match(mails[0].text, /alt@example\.org/);
  assert.match(mails[0].text, /neu@example\.org/);
});

test('parseEmpfaengerListe und formatierePruefnummer', () => {
  assert.deepEqual(parseEmpfaengerListe(' a@b.ch, ,a@b.ch,kaputt, c@d.org '), { adressen: ['a@b.ch', 'c@d.org'], ungueltig: ['kaputt'] });
  assert.deepEqual(parseEmpfaengerListe(''), { adressen: [], ungueltig: [] });
  assert.equal(formatierePruefnummer('a'.repeat(16) + 'b'.repeat(8)), 'aaaaaaaa aaaaaaaa bbbbbbbb');
});
