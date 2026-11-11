import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { seedDefaults } from '../../src/db/adminConfigRepo.js';
import { setzeWartungsmodus } from '../../src/services/wartungsmodus.js';
import { sendRenderedMail } from '../../src/services/notify.js';
import { reiheMailEin, stelleFaelligeMailsZu, stelleDigestZu, stelleMailZu } from '../../src/services/mailZustellung.js';
import { versendeFaelligeAlarme } from '../../src/services/sicherheitsalarme.js';
import { startScheduler } from '../../src/services/scheduler.js';

const CONFIG = { publicBaseUrl: 'https://portal.example.org', churchtools: {} };

function fakeMailer() {
  const gesendet = [];
  return { gesendet, sendMail: async (m) => { gesendet.push(m); } };
}

const zeile = (db, id) => ({ ...db.prepare('SELECT status, versuche FROM mail_log WHERE id = ?').get(id) });

test('Mail im Wartungsmodus: nicht gesendet, bleibt eingereiht ohne Versuch; nach dem Ausschalten zugestellt', async () => {
  const db = openDatabase(':memory:');
  const mailer = fakeMailer();
  setzeWartungsmodus(db, true);
  const ergebnis = await sendRenderedMail(db, mailer, { to: 'a@example.org', subject: 'S', text: 'T', typ: 'testmail', jobId: null });
  assert.equal(mailer.gesendet.length, 0);
  assert.equal(ergebnis.status, 'eingereiht');
  assert.deepEqual(zeile(db, ergebnis.id), { status: 'eingereiht', versuche: 0 });

  const waehrend = await stelleFaelligeMailsZu(db, CONFIG, mailer);
  assert.equal(mailer.gesendet.length, 0);
  assert.deepEqual(zeile(db, ergebnis.id), { status: 'eingereiht', versuche: 0 });
  assert.ok(waehrend);

  setzeWartungsmodus(db, false);
  await stelleFaelligeMailsZu(db, CONFIG, mailer);
  assert.equal(mailer.gesendet.length, 1);
  assert.equal(zeile(db, ergebnis.id).status, 'versendet');
  db.close();
});

test('stelleMailZu meldet zurückgehalten und beansprucht die Zeile nicht', async () => {
  const db = openDatabase(':memory:');
  const id = reiheMailEin(db, { typ: 'testmail', jobId: null, empfaenger: 'a@example.org', betreff: 'S', text: 'T' });
  setzeWartungsmodus(db, true);
  const r = await stelleMailZu(db, fakeMailer(), id);
  assert.equal(r.zurueckgehalten, true);
  assert.equal(r.beansprucht, false);
  assert.equal(db.prepare('SELECT sperre_token FROM mail_log WHERE id = ?').get(id).sperre_token, null);
  db.close();
});

test('Digest im Wartungsmodus: nichts gesendet, Zeilen bleiben geplant', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  const mailer = fakeMailer();
  const id = reiheMailEin(db, { typ: 'testmail', jobId: null, empfaenger: 'a@example.org', betreff: 'S', text: 'T', geplant: true });
  setzeWartungsmodus(db, true);
  const status = await stelleDigestZu(db, CONFIG, mailer, { empfaenger: 'a@example.org', ids: [id], vorlage: { betreff: 'B', text: 'T' } });
  assert.equal(status, null);
  assert.equal(mailer.gesendet.length, 0);
  assert.equal(zeile(db, id).status, 'geplant');
  db.close();
});

test('Sicherheitsalarm-Versand ist im Wartungsmodus zurückgestellt', async () => {
  const db = openDatabase(':memory:');
  const mailer = fakeMailer();
  setzeWartungsmodus(db, true);
  const r = await versendeFaelligeAlarme(db, CONFIG, mailer);
  assert.equal(r.zurueckgehalten, true);
  assert.equal(mailer.gesendet.length, 0);
  db.close();
});

function fakeJobs(overrides = {}) {
  const ok = async () => ({ status: 'erfolg' });
  return {
    runSyncPersonenJob: ok, runPoolErinnerungenJob: ok, runPdfBereinigungJob: ok, runZeitstempelNachholenJob: ok,
    runDatenbankSicherungJob: ok, runSplitGruppenNachholenJob: ok, runMailDigestJob: ok, runFreigabe2ErinnerungenJob: ok,
    runKkBelegErinnerungenJob: ok, ...overrides,
  };
}

test('Scheduler: im Wartungsmodus laufen die Jobs nicht, die Datenbank-Sicherung schon', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const db = openDatabase(':memory:');
  seedDefaults(db);
  let pool = 0;
  let sicherung = 0;
  setzeWartungsmodus(db, true);
  startScheduler({
    db, config: {}, mailer: {},
    jobs: fakeJobs({ runPoolErinnerungenJob: async () => { pool += 1; return { status: 'erfolg' }; }, runDatenbankSicherungJob: () => { sicherung += 1; return { status: 'erfolg' }; } }),
  });
  for (let i = 0; i < 26; i += 1) {
    t.mock.timers.tick(60 * 60 * 1000);
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(pool, 0, 'Pool-Erinnerungen pausieren');
  assert.ok(sicherung >= 1, 'Sicherung läuft weiter');
  setzeWartungsmodus(db, false);
  t.mock.timers.tick(60 * 60 * 1000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(pool >= 1, 'nach dem Ausschalten laufen die Jobs wieder');
  db.close();
});
