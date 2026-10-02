import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { setConfigValue } from '../../src/db/adminConfigRepo.js';
import { listUnresolvedBackupDeletions, reviewBackupDeletion } from '../../src/services/backupAudit.js';
import { withAuditActor } from '../../src/services/auditContext.js';
import {
  runSicherheitsalarmeJob, erkenneOffeneBackupLoeschungen, versendeFaelligeAlarme, MINDESTALTER_MS,
} from '../../src/services/sicherheitsalarme.js';

const T0 = Date.parse('2026-09-29T12:00:00Z');
const config = { churchtools: { groupIdAdmin: '20', groupIdBuchhaltung: '10' }, publicBaseUrl: 'https://portal.example.org' };

function setup(t) {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  setConfigValue(db, 'sicherheitsalarm_empfaenger', 'alarm@example.org\nzweite@example.org');
  return db;
}

function absicht(db, zeitpunkt, dateiname = 'backup-2026-09-28T00-00-00-000Z.fpbak') {
  return Number(db.prepare(`INSERT INTO audit_ereignisse (zeitpunkt, person_id, person_name, objekt, objekt_id, aktion, nachher)
    VALUES (?, 'system', 'System', 'backup', ?, 'backup_loeschung_beabsichtigt', ?)`).run(new Date(zeitpunkt).toISOString(), dateiname, JSON.stringify({ operationId: 'op-1' })).lastInsertRowid);
}

function mailer({ fehler = null, verzoegerung = null } = {}) {
  const calls = [];
  return {
    calls,
    async sendMail(mail) {
      calls.push(mail);
      if (verzoegerung) await verzoegerung;
      if (fehler) throw fehler;
    },
  };
}

const alarme = (db) => db.prepare('SELECT * FROM sicherheitsalarme ORDER BY id').all();
const alt = T0 - MINDESTALTER_MS - 1000;

test('detection is repeatable, deduplicated and ignores intents younger than the minimum age', (t) => {
  const db = setup(t);
  const id = absicht(db, alt);
  absicht(db, T0 - 1000);
  assert.equal(erkenneOffeneBackupLoeschungen(db, { jetzt: T0 }).neu, 1);
  assert.equal(erkenneOffeneBackupLoeschungen(db, { jetzt: T0 }).neu, 0);
  assert.deepEqual(alarme(db).map((a) => [a.schluessel, a.status]), [[String(id), 'ausstehend']]);
});

test('successful alert is logged and audited but never resolves the deletion intent', async (t) => {
  const db = setup(t);
  const id = absicht(db, alt);
  const m = mailer();
  const ergebnis = await withAuditActor({ id: 'system', name: 'System' }, () => runSicherheitsalarmeJob(db, config, m, { jetzt: T0 }));
  assert.equal(ergebnis.status, 'erfolg');
  assert.equal(m.calls.length, 1);
  assert.equal(m.calls[0].to, 'alarm@example.org, zweite@example.org');
  assert.match(m.calls[0].text, new RegExp(`Vorgang ${id}: backup-2026-09-28`));
  assert.match(m.calls[0].text, /klaert keinen Vorgang/);
  assert.equal(alarme(db)[0].status, 'versendet');
  assert.equal(db.prepare("SELECT status FROM mail_log WHERE typ = 'sicherheitsalarm'").get().status, 'versendet');
  assert.deepEqual(listUnresolvedBackupDeletions(db).map((row) => row.id), [id]);
  assert.equal(db.prepare("SELECT count(*) AS n FROM audit_ereignisse WHERE aktion = 'backup_loeschung_geprueft'").get().n, 0);
  const audit = db.prepare("SELECT nachher FROM audit_ereignisse WHERE aktion = 'sicherheitsalarm_versendet'").get();
  assert.deepEqual(JSON.parse(audit.nachher), { absichtIds: [id], empfaengerAnzahl: 2 });
  // Repeated runs do not resend until the reminder interval has passed.
  await runSicherheitsalarmeJob(db, config, m, { jetzt: T0 + 60 * 60 * 1000 });
  assert.equal(m.calls.length, 1);
  await runSicherheitsalarmeJob(db, config, m, { jetzt: T0 + 25 * 60 * 60 * 1000 });
  assert.equal(m.calls.length, 2);
  assert.equal(alarme(db)[0].erinnerungen, 1);
});

test('send failure is persisted with a code only and retried with backoff', async (t) => {
  const db = setup(t);
  absicht(db, alt);
  const kaputt = mailer({ fehler: Object.assign(new Error('Login failed for user secret-user:secret-pass'), { code: 'EAUTH' }) });
  const erster = await runSicherheitsalarmeJob(db, config, kaputt, { jetzt: T0 });
  assert.equal(erster.status, 'fehler');
  let [alarm] = alarme(db);
  assert.deepEqual([alarm.status, alarm.versuche, alarm.letzter_fehler, alarm.naechster_versuch_am], ['ausstehend', 1, 'EAUTH', new Date(T0 + 5 * 60 * 1000).toISOString()]);
  const log = db.prepare("SELECT * FROM mail_log WHERE typ = 'sicherheitsalarm'").get();
  assert.equal(log.status, 'fehlgeschlagen');
  assert.equal(log.fehler_details, 'EAUTH');
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM audit_ereignisse').all()).includes('secret-pass'));
  await runSicherheitsalarmeJob(db, config, kaputt, { jetzt: T0 + 60 * 1000 });
  assert.equal(kaputt.calls.length, 1, 'no retry before backoff');
  await runSicherheitsalarmeJob(db, config, kaputt, { jetzt: T0 + 5 * 60 * 1000 });
  [alarm] = alarme(db);
  assert.equal(alarm.versuche, 2);
  assert.equal(alarm.naechster_versuch_am, new Date(T0 + 5 * 60 * 1000 + 10 * 60 * 1000).toISOString());
  const gut = mailer();
  await runSicherheitsalarmeJob(db, config, gut, { jetzt: T0 + 20 * 60 * 1000 });
  assert.equal(gut.calls.length, 1);
  assert.equal(alarme(db)[0].status, 'versendet');
});

test('missing recipients count as a failed, retried alert', async (t) => {
  const db = setup(t);
  setConfigValue(db, 'sicherheitsalarm_empfaenger', '');
  absicht(db, alt);
  const m = mailer();
  const ergebnis = await runSicherheitsalarmeJob(db, config, m, { jetzt: T0 });
  assert.equal(ergebnis.fehler, 'KEINE_EMPFAENGER');
  assert.equal(m.calls.length, 0);
  assert.equal(alarme(db)[0].status, 'ausstehend');
});

test('parallel runs send exactly one alert', async (t) => {
  const db = setup(t);
  absicht(db, alt);
  let freigeben;
  const m = mailer({ verzoegerung: new Promise((resolve) => { freigeben = resolve; }) });
  const erster = runSicherheitsalarmeJob(db, config, m, { jetzt: T0 });
  const zweiter = await runSicherheitsalarmeJob(db, config, m, { jetzt: T0 });
  assert.equal(zweiter.versendet, 0);
  freigeben();
  assert.equal((await erster).versendet, 1);
  assert.equal(m.calls.length, 1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM mail_log WHERE typ = 'sicherheitsalarm'").get().n, 1);
});

test('intents reviewed in the meantime end the alert without mail; the review itself stays the only resolution', async (t) => {
  const db = setup(t);
  const id = absicht(db, alt);
  erkenneOffeneBackupLoeschungen(db, { jetzt: T0 });
  withAuditActor({ id: '99', name: 'Admin' }, () => reviewBackupDeletion(db, id, 'datei_nicht_vorhanden', 'Dateibestand geprueft, Datei entfernt'));
  const m = mailer();
  const ergebnis = await versendeFaelligeAlarme(db, config, m, { jetzt: T0 });
  assert.equal(ergebnis.erledigt, 1);
  assert.equal(m.calls.length, 0);
  assert.equal(alarme(db)[0].status, 'erledigt');
  assert.throws(() => db.prepare('DELETE FROM sicherheitsalarme').run(), /nicht geloescht/);
});

test('an alert already sent is ended once its intent is reviewed and not reminded again', async (t) => {
  const db = setup(t);
  const id = absicht(db, alt);
  const m = mailer();
  await runSicherheitsalarmeJob(db, config, m, { jetzt: T0 });
  reviewBackupDeletion(db, id, 'datei_vorhanden', 'Datei liegt noch vor, Loeschung nicht erfolgt');
  await runSicherheitsalarmeJob(db, config, m, { jetzt: T0 + 48 * 60 * 60 * 1000 });
  assert.equal(m.calls.length, 1);
  assert.equal(alarme(db)[0].status, 'erledigt');
});
