import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { seedDefaults, setConfigValue, getConfigValue } from '../../src/db/adminConfigRepo.js';
import { runAuditExportJob, listPaketeOhneZeitstempel, ladeAuditZeitstempel } from '../../src/services/auditNachweisJobs.js';

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
