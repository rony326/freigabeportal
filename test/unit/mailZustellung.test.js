import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/db/index.js';
import { seedDefaults, setConfigValue } from '../../src/db/adminConfigRepo.js';
import { createJob, getJobById } from '../../src/db/jobsRepo.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { listMailLog, listMailAnhaenge, pruneMailLogOlderThan } from '../../src/db/mailLogRepo.js';
import { runPoolErinnerungenJob, runMailZustellungJob, runMailDigestJob } from '../../src/services/cronJobs.js';
import { sendNotification } from '../../src/services/notify.js';
import { reiheMailEin, stelleMailZu, stelleFaelligeMailsZu, wartezeitNachVersuch, SPERRE_MS } from '../../src/services/mailZustellung.js';

// Regressionen zum Befund "SMTP-Ausfall verbraucht Erinnerungen ohne automatischen
// Wiederholungsversuch" (docs/review-frischer-blick-2026-09-29.md, Abschnitt 2).

const CONFIG = { publicBaseUrl: 'https://portal.example.org', churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20' } };

function mailer({ failFor = () => false, delayMs = 0 } = {}) {
  const versuche = [];
  const sent = [];
  return {
    versuche,
    sent,
    async sendMail(mail) {
      versuche.push(mail);
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (failFor(mail)) throw new Error('SMTP 421 Service not available');
      sent.push(mail);
    },
  };
}

function faelligMachen(db) {
  db.prepare("UPDATE mail_log SET naechster_versuch_am = '2000-01-01T00:00:00.000Z' WHERE naechster_versuch_am IS NOT NULL").run();
}

function setup({ empfaenger = ['buch@example.org'] } = {}) {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  setConfigValue(db, 'reminder_empfaenger', empfaenger.join('\n'));
  setConfigValue(db, 'eskalation_stunden', '100000');
  const jobId = createJob(db, { eingangAm: '2020-01-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'alt.pdf', pdfPfad: '/tmp/a.pdf' });
  return { db, jobId };
}

test('Reproduktion: SMTP-Ausfall beim Pool-Reminder wird sichtbar, bleibt eingereiht und wird automatisch nachgeholt', async () => {
  const { db, jobId } = setup();
  const kaputt = mailer({ failFor: () => true });

  const lauf1 = await runPoolErinnerungenJob(db, CONFIG, kaputt);
  const lauf2 = await runPoolErinnerungenJob(db, CONFIG, kaputt);

  assert.equal(lauf1.status, 'fehler', 'a run whose delivery failed must not report erfolg');
  assert.match(lauf1.error, /zur Wiederholung eingereiht: 1/);
  assert.equal(lauf2.reminder, 0, 'the reminder itself is not re-planned (it is already queued)');
  assert.equal(kaputt.versuche.length, 1);
  const [zeile] = listMailLog(db);
  assert.equal(zeile.status, 'eingereiht');
  assert.ok(getJobById(db, jobId).reminder_gesendet_at, 'marker set together with the durable queue entry');
  const laeufe = db.prepare("SELECT status, details FROM cron_log WHERE job = 'pool-erinnerungen' ORDER BY id").all();
  assert.equal(laeufe[0].status, 'fehler');
  assert.match(laeufe[0].details, /Reminder: 1, Eskalation: 0; Mails versendet: 0, zur Wiederholung eingereiht: 1/);

  // Mailserver wieder da, Wartezeit abgelaufen: der Wiederholungsjob stellt zu.
  faelligMachen(db);
  const heil = mailer();
  const retry = await runMailZustellungJob(db, CONFIG, heil);
  assert.equal(retry.status, 'erfolg');
  assert.equal(heil.sent.length, 1);
  assert.equal(heil.sent[0].to, 'buch@example.org');
  assert.equal(listMailLog(db)[0].status, 'versendet');
  assert.equal(listMailLog(db)[0].versuche, 2);

  // Danach nichts mehr fällig -- keine erneute Zustellung, kein Protokolleintrag.
  const leer = await runMailZustellungJob(db, CONFIG, heil);
  assert.equal(leer.status, 'uebersprungen');
  assert.equal(heil.sent.length, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM cron_log WHERE job = 'mail-zustellung'").get().n, 1);
  db.close();
});

test('Teilerfolg: nur der gescheiterte Empfänger wird wiederholt, der erfolgreiche nie erneut', async () => {
  const { db } = setup({ empfaenger: ['ok@example.org', 'kaputt@example.org'] });
  const teilweise = mailer({ failFor: (m) => m.to === 'kaputt@example.org' });

  const lauf = await runPoolErinnerungenJob(db, CONFIG, teilweise);
  assert.equal(lauf.status, 'fehler');
  assert.deepEqual(lauf.mails, { versendet: 1, wiederholung: 1, fehlgeschlagen: 0, geplant: 0 });

  faelligMachen(db);
  const heil = mailer();
  await runMailZustellungJob(db, CONFIG, heil);
  assert.deepEqual(heil.sent.map((m) => m.to), ['kaputt@example.org']);
  assert.ok(listMailLog(db).every((m) => m.status === 'versendet'));
  db.close();
});

test('parallele Auslöser planen eine Erinnerung nur einmal und versenden jede Zeile nur einmal', async () => {
  const { db } = setup({ empfaenger: ['a@example.org', 'b@example.org'] });
  const langsam = mailer({ delayMs: 20 });

  const [l1, l2] = await Promise.all([runPoolErinnerungenJob(db, CONFIG, langsam), runPoolErinnerungenJob(db, CONFIG, langsam)]);

  assert.equal(l1.reminder + l2.reminder, 1);
  assert.equal(listMailLog(db).length, 2);
  assert.deepEqual(langsam.sent.map((m) => m.to).sort(), ['a@example.org', 'b@example.org']);

  // Zwei parallele Wiederholungsläufe über dieselben fälligen Zeilen.
  const id1 = reiheMailEin(db, { typ: 'reminder', jobId: null, empfaenger: 'x@example.org', betreff: 'B', text: 'T' });
  const id2 = reiheMailEin(db, { typ: 'reminder', jobId: null, empfaenger: 'y@example.org', betreff: 'B', text: 'T' });
  const zweiter = mailer({ delayMs: 20 });
  await Promise.all([stelleFaelligeMailsZu(db, CONFIG, zweiter), stelleFaelligeMailsZu(db, CONFIG, zweiter)]);
  assert.deepEqual(zweiter.sent.map((m) => m.to).sort(), ['x@example.org', 'y@example.org']);
  for (const id of [id1, id2]) assert.equal(db.prepare('SELECT status FROM mail_log WHERE id = ?').get(id).status, 'versendet');
  db.close();
});

test('Prozessneustart: eine verwaiste Sperre läuft ab und die Zeile wird zugestellt; eine aktive Sperre wird respektiert', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  const jetzt = Date.now();
  const verwaist = reiheMailEin(db, { typ: 'reminder', jobId: null, empfaenger: 'verwaist@example.org', betreff: 'B', text: 'T', jetzt: jetzt - SPERRE_MS * 2 });
  db.prepare('UPDATE mail_log SET sperre_token = ?, sperre_bis = ? WHERE id = ?').run('alter-prozess', new Date(jetzt - 1000).toISOString(), verwaist);
  const aktiv = reiheMailEin(db, { typ: 'reminder', jobId: null, empfaenger: 'aktiv@example.org', betreff: 'B', text: 'T', jetzt: jetzt - 1000 });
  db.prepare('UPDATE mail_log SET sperre_token = ?, sperre_bis = ? WHERE id = ?').run('laufender-versand', new Date(jetzt + SPERRE_MS).toISOString(), aktiv);

  // Ein frisch gestarteter Prozess (neue Verbindung, gleicher Datenbankinhalt) greift auf.
  const m = mailer();
  const bilanz = await stelleFaelligeMailsZu(db, CONFIG, m);
  assert.deepEqual(m.sent.map((x) => x.to), ['verwaist@example.org']);
  assert.equal(bilanz.versendet, 1);
  assert.equal(db.prepare('SELECT status FROM mail_log WHERE id = ?').get(aktiv).status, 'eingereiht');
  db.close();
});

test('wachsender Abstand und begrenzte Versuche: danach fehlgeschlagen und keine automatische Wiederholung mehr', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  setConfigValue(db, 'mail_zustellung_max_versuche', '3');
  assert.equal(wartezeitNachVersuch(1), 5 * 60 * 1000);
  assert.equal(wartezeitNachVersuch(2), 10 * 60 * 1000);
  assert.equal(wartezeitNachVersuch(3), 20 * 60 * 1000);
  assert.equal(wartezeitNachVersuch(20), 6 * 60 * 60 * 1000);

  const kaputt = mailer({ failFor: () => true });
  const ergebnis = await sendNotification(db, kaputt, { to: 'x@example.org', typ: 'reminder', jobId: null, variablen: { jobDateiname: 'a.pdf', stunden: 1, link: 'l' } });
  assert.equal(ergebnis.status, 'eingereiht');
  const abstand = () => {
    const z = listMailLog(db)[0];
    return Date.parse(z.naechster_versuch_am) - Date.parse(z.versucht_am);
  };
  assert.equal(abstand(), 5 * 60 * 1000);
  faelligMachen(db);
  let lauf = await runMailZustellungJob(db, CONFIG, kaputt);
  assert.equal(lauf.status, 'fehler');
  assert.equal(abstand(), 10 * 60 * 1000);
  faelligMachen(db);
  lauf = await runMailZustellungJob(db, CONFIG, kaputt);
  assert.equal(lauf.mails.fehlgeschlagen, 1);
  const [zeile] = listMailLog(db);
  assert.equal(zeile.status, 'fehlgeschlagen');
  assert.equal(zeile.versuche, 3);
  assert.equal((await runMailZustellungJob(db, CONFIG, kaputt)).status, 'uebersprungen');
  assert.equal(kaputt.versuche.length, 3);
  db.close();
});

test('gescheiterter Digest bleibt geplant und wird vom Wiederholungsjob als Digest zugestellt', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  setConfigValue(db, 'mail_standard_benachrichtigung', 'taeglich');
  for (const n of [1, 2]) {
    await sendNotification(db, mailer(), { to: 'a@example.org', typ: 'zuweisung', jobId: null, variablen: { empfaengerName: 'A', jobDateiname: `r${n}.pdf`, grund: 'G', link: 'l' } });
  }
  assert.ok(listMailLog(db).every((m) => m.status === 'geplant'));

  const digest = await runMailDigestJob(db, CONFIG, mailer({ failFor: () => true }));
  assert.equal(digest.status, 'fehler');
  assert.ok(listMailLog(db).every((m) => m.status === 'geplant' && m.versuche === 1));

  faelligMachen(db);
  const heil = mailer();
  const retry = await runMailZustellungJob(db, CONFIG, heil);
  assert.equal(retry.status, 'erfolg');
  assert.equal(heil.sent.length, 1, 'one digest, not one mail per row');
  assert.match(heil.sent[0].subject, /2 Ereignisse/);
  assert.ok(listMailLog(db).every((m) => m.status === 'versendet'));
  db.close();
});

test('Aufbewahrungsfrist löscht nie noch zuzustellende Zeilen', () => {
  const db = openDatabase(':memory:');
  reiheMailEin(db, { typ: 'reminder', jobId: null, empfaenger: 'a@example.org', betreff: 'B', text: 'T', jetzt: Date.parse('2020-01-01T00:00:00.000Z') });
  reiheMailEin(db, { typ: 'reminder', jobId: null, empfaenger: 'b@example.org', betreff: 'B', text: 'T', geplant: true, jetzt: Date.parse('2020-01-01T00:00:00.000Z') });
  db.prepare("INSERT INTO mail_log (typ, empfaenger, betreff, text, status, versucht_am) VALUES ('reminder', 'c@example.org', 'B', 'T', 'versendet', '2020-01-01T00:00:00.000Z')").run();

  assert.equal(pruneMailLogOlderThan(db, '2021-01-01T00:00:00.000Z'), 1);
  assert.deepEqual(listMailLog(db).map((m) => m.status).sort(), ['eingereiht', 'geplant']);
  db.close();
});

test('Migration: bestehende mail_log- und cron_log-Tabellen werden rückwärtskompatibel erweitert', () => {
  const dir = mkdtempSync(join(tmpdir(), 'db-migration-test-'));
  const dbPath = join(dir, 'legacy.sqlite');
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE mail_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      typ TEXT NOT NULL CHECK (typ IN ('zuweisung', 'reminder', 'eskalation', 'ablehnung', 'sync-fehler', 'iban-warnung', 'rechnungsnummer-warnung', 'freigabe2-reminder', 'freigabe2-eskalation', 'kk-abrechnung-zugewiesen', 'kk-beleg-erinnerung', 'kk-beleg-eingegangen', 'sicherheitsalarm')),
      job_id INTEGER,
      empfaenger TEXT NOT NULL,
      betreff TEXT NOT NULL,
      text TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('versendet', 'fehlgeschlagen', 'geplant')),
      fehler_details TEXT,
      versucht_am TEXT NOT NULL
    );
    INSERT INTO mail_log (typ, empfaenger, betreff, text, status, fehler_details, versucht_am)
      VALUES ('reminder', 'alt@example.org', 'B', 'T', 'fehlgeschlagen', 'SMTP down', '2026-09-01T00:00:00.000Z');
    INSERT INTO mail_log (typ, empfaenger, betreff, text, status, versucht_am)
      VALUES ('zuweisung', 'geplant@example.org', 'B', 'T', 'geplant', '2026-09-01T00:00:00.000Z');
    CREATE TABLE cron_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job TEXT NOT NULL CHECK(job IN ('pool-erinnerungen', 'pdf-bereinigung', 'zeitstempel-nachholen', 'datenbank-sicherung', 'split-gruppen-nachholen', 'mail-digest', 'freigabe2-erinnerungen', 'kk-beleg-erinnerungen')),
      gestartet_am TEXT NOT NULL, beendet_am TEXT,
      status TEXT NOT NULL CHECK(status IN ('erfolg', 'fehler', 'laufend')), details TEXT
    );
    INSERT INTO cron_log (job, gestartet_am, status, details) VALUES ('mail-digest', '2026-09-01T00:00:00.000Z', 'erfolg', 'alt');
  `);
  legacy.close();

  const db = openDatabase(dbPath);
  const [alt, geplant] = db.prepare('SELECT * FROM mail_log ORDER BY id').all();
  assert.equal(alt.status, 'fehlgeschlagen');
  assert.equal(alt.fehler_details, 'SMTP down');
  assert.equal(alt.versuche, 0);
  assert.equal(geplant.status, 'geplant');
  assert.doesNotThrow(() => reiheMailEin(db, { typ: 'reminder', jobId: null, empfaenger: 'neu@example.org', betreff: 'B', text: 'T' }));
  assert.equal(db.prepare("SELECT details FROM cron_log WHERE job = 'mail-digest'").get().details, 'alt');
  assert.doesNotThrow(() => db.prepare("INSERT INTO cron_log (job, gestartet_am, status) VALUES ('mail-zustellung', '2026-09-30T00:00:00.000Z', 'erfolg')").run());
  db.close();
  // Zweites Öffnen: idempotent.
  openDatabase(dbPath).close();
  rmSync(dir, { recursive: true, force: true });
});

test('Freigabe-2-Eskalation und ihre Mail werden gemeinsam gespeichert, auch wenn SMTP ausfällt', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  const { createKonto } = await import('../../src/db/kontenRepo.js');
  const { runFreigabe2ErinnerungenJob } = await import('../../src/services/cronJobs.js');
  for (const id of ['1', '2', '3', '4']) upsertPerson(db, { id, vorname: `P${id}`, nachname: 'M', email: `p${id}@example.org`, gruppen: [], loggedInNow: false });
  upsertPerson(db, { id: '99', vorname: 'Ad', nachname: 'Min', email: 'admin@example.org', gruppen: ['20'], loggedInNow: false });
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'U', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  const jobId = createJob(db, { eingangAm: '2020-01-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'alt.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare("UPDATE jobs SET status = 'freigabe2', konto_id = ?, freigabe2_seit = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(kontoId, jobId);

  const lauf = await runFreigabe2ErinnerungenJob(db, CONFIG, mailer({ failFor: () => true }));

  assert.equal(lauf.status, 'fehler');
  assert.equal(lauf.eskalation, 1);
  const job = getJobById(db, jobId);
  assert.equal(job.freigabe2_eskaliert_an_admin, 1);
  assert.ok(job.freigabe2_eskalation_gesendet_at);
  const mails = listMailLog(db);
  assert.deepEqual(mails.map((m) => m.status), ['eingereiht', 'eingereiht']);
  for (const m of mails) assert.match(m.text, new RegExp(`https://portal\\.example\\.org/freigabe2/${jobId}\\b`));
  db.close();
});

// Legt eine PDF-Datei ab und reiht eine Mail mit genau diesem Anhang ein.
function mailMitAnhang(t, { sha256 = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mail-anhang-'));
  const db = openDatabase(':memory:');
  seedDefaults(db);
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const bytes = Buffer.from('%PDF-1.4 Beleg \x00\xff', 'latin1');
  const pfad = join(dir, 'kopie.pdf');
  writeFileSync(pfad, bytes);
  const anhang = { dateiname: 'a.pdf', pfad, sha256: sha256 ?? createHash('sha256').update(bytes).digest('hex') };
  const id = reiheMailEin(db, { typ: 'reminder', jobId: null, empfaenger: 'x@example.org', betreff: 'B', text: 'T', anhaenge: [anhang] });
  return { db, id, pfad, bytes, anhang };
}

test('Anhänge werden mit Inhalt zugestellt', async (t) => {
  const { db, id, bytes, anhang } = mailMitAnhang(t);
  assert.deepEqual(listMailAnhaenge(db, id), [anhang]);
  const heil = mailer();

  const ergebnis = await stelleMailZu(db, heil, id);

  assert.equal(ergebnis.status, 'versendet');
  assert.equal(heil.sent[0].attachments.length, 1);
  assert.equal(heil.sent[0].attachments[0].filename, 'a.pdf');
  assert.equal(heil.sent[0].attachments[0].contentType, 'application/pdf');
  assert.ok(heil.sent[0].attachments[0].content.equals(bytes));
  assert.equal(listMailLog(db)[0].status, 'versendet');
});

test('Mails ohne Anhang werden ohne attachments-Schlüssel versendet', async (t) => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  t.after(() => db.close());
  const id = reiheMailEin(db, { typ: 'reminder', jobId: null, empfaenger: 'x@example.org', betreff: 'B', text: 'T' });
  const heil = mailer();
  await stelleMailZu(db, heil, id);
  assert.deepEqual(Object.keys(heil.sent[0]).sort(), ['subject', 'text', 'to']);
});

test('Fehlender Anhang → Wiederholung mit klarer Meldung', async (t) => {
  const { db, id, pfad } = mailMitAnhang(t);
  rmSync(pfad);
  const heil = mailer();

  const ergebnis = await stelleMailZu(db, heil, id);

  assert.equal(ergebnis.status, 'eingereiht');
  assert.equal(heil.versuche.length, 0);
  assert.match(listMailLog(db)[0].fehler_details, /Anhang a\.pdf fehlt \(Versuch/);
  assert.ok(!listMailLog(db)[0].fehler_details.includes(pfad), 'kein absoluter Pfad im Protokoll');
});

test('Veränderter Anhang → Wiederholung', async (t) => {
  const { db, id } = mailMitAnhang(t, { sha256: '0'.repeat(64) });
  const heil = mailer();

  const ergebnis = await stelleMailZu(db, heil, id);

  assert.equal(ergebnis.status, 'eingereiht');
  assert.equal(heil.versuche.length, 0);
  assert.match(listMailLog(db)[0].fehler_details, /Anhang a\.pdf stimmt nicht mit dem gespeicherten Hash überein/);
});

test('Mail und Anhänge werden gemeinsam gespeichert oder gar nicht', (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  assert.throws(() => reiheMailEin(db, {
    typ: 'reminder', jobId: null, empfaenger: 'x@example.org', betreff: 'B', text: 'T',
    anhaenge: [{ dateiname: 'a.pdf', pfad: '/tmp/a.pdf', sha256: 'ab' }, { dateiname: 'b.pdf', pfad: '/tmp/b.pdf', sha256: null }],
  }));
  assert.equal(listMailLog(db).length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM mail_anhaenge').get().n, 0);
});

test('Geplante Mail mit Anhängen wird abgelehnt (der Digest würde die Anhänge still verlieren)', (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  assert.throws(() => reiheMailEin(db, {
    typ: 'reminder', jobId: null, empfaenger: 'x@example.org', betreff: 'B', text: 'T', geplant: true,
    anhaenge: [{ dateiname: 'a.pdf', pfad: '/tmp/a.pdf', sha256: 'ab' }],
  }), /Anh[äa]ng/);
  assert.equal(listMailLog(db).length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM mail_anhaenge').get().n, 0);
});

test('Anderer Lesefehler beim Anhang nennt den Fehlercode, nie den Pfad', async (t) => {
  const { db, id, pfad } = mailMitAnhang(t);
  // Ein Verzeichnis an Stelle der Datei: Lesen scheitert mit EISDIR.
  rmSync(pfad);
  mkdirSync(pfad);

  await stelleMailZu(db, mailer(), id);

  const { fehler_details: details } = listMailLog(db)[0];
  assert.match(details, /Anhang a\.pdf fehlt \(EISDIR\)/);
  assert.ok(!details.includes(pfad), 'kein absoluter Pfad im Protokoll');
});
