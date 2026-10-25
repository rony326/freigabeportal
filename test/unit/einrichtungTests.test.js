import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/db/index.js';
import { seedDefaults } from '../../src/db/adminConfigRepo.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { setupMockChurchTools } from '../helpers/mockChurchTools.js';
import { pruefeTechnik, testeChurchtools, sendeTestmail, loeseKernjobsAus } from '../../src/services/einrichtungTests.js';

const GEHEIM = 'geheimer-token-xyz';
const mailInsert = (typ) => `INSERT INTO mail_log (typ, job_id, empfaenger, betreff, text, status, versucht_am) VALUES ('${typ}', NULL, 'x@example.org', 'B', 'T', 'eingereiht', '2026-10-01')`;

function temp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'einr-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function configFuer(dir, extra = {}) {
  return {
    publicBaseUrl: 'https://portal.example.org',
    dbPath: join(dir, 'daten', 'db.sqlite'),
    jobsDir: join(dir, 'daten', 'jobs'),
    brandingDir: join(dir, 'daten', 'branding'),
    backupDir: join(dir, 'daten', 'backups'),
    backupApiKey: GEHEIM,
    tsaTrustAnchorsFile: null,
    churchtools: { baseUrl: 'https://ct.example.org', groupIdBuchhaltung: '10', groupIdAdmin: '20', groupIdManager: '30', syncServiceToken: GEHEIM },
    ...extra,
  };
}
const nach = (arr, name) => arr.find((p) => p.name === name);
const app = (dir) => join(dir, 'app');

test('pruefeTechnik: alles in Ordnung, keine Werte im Ergebnis', (t) => {
  const dir = temp(t);
  const erg = pruefeTechnik(configFuer(dir), { anwendungsVerzeichnis: app(dir) });
  assert.ok(Array.isArray(erg) && erg.length > 0);
  for (const p of erg) {
    assert.ok(['ok', 'warnung', 'fehlt', 'ungültig'].includes(p.status), p.name);
    assert.equal(typeof p.hinweis, 'string');
  }
  assert.equal(erg.filter((p) => p.status !== 'ok').length, 0);
  assert.ok(!JSON.stringify(erg).includes(GEHEIM));
  assert.ok(!JSON.stringify(erg).includes('portal.example.org'));
});

test('pruefeTechnik: http-URL ergibt Warnung', (t) => {
  const dir = temp(t);
  const erg = pruefeTechnik(configFuer(dir, { publicBaseUrl: 'http://portal.example.org' }), { anwendungsVerzeichnis: app(dir) });
  assert.equal(nach(erg, 'Öffentliche Adresse').status, 'warnung');
});

test('pruefeTechnik: Pfad im Anwendungsverzeichnis ergibt Warnung', (t) => {
  const dir = temp(t);
  const erg = pruefeTechnik(configFuer(dir), { anwendungsVerzeichnis: dir });
  const p = nach(erg, 'Speicherort Datenbank');
  assert.equal(p.status, 'warnung');
  assert.match(p.hinweis, /Deploy überschrieben/);
});

test('pruefeTechnik: nicht beschreibbar ergibt ungültig', (t) => {
  const dir = temp(t);
  const fs = {
    mkdirSync() {},
    accessSync(pfad) { if (String(pfad).includes('jobs')) throw new Error('EACCES'); },
    existsSync: () => true,
    statSync: () => ({ isDirectory: () => true }),
  };
  const erg = pruefeTechnik(configFuer(dir), { anwendungsVerzeichnis: app(dir), fs });
  assert.equal(nach(erg, 'Speicherort Belege').status, 'ungültig');
  assert.equal(nach(erg, 'Speicherort Datenbank').status, 'ok');
});

test('pruefeTechnik: optionale Variablen fehlen = ok mit Hinweis optional', (t) => {
  const dir = temp(t);
  const config = configFuer(dir, { backupApiKey: null });
  config.churchtools.groupIdManager = null;
  const erg = pruefeTechnik(config, { anwendungsVerzeichnis: app(dir) });
  for (const n of ['Backup-Schlüssel', 'Manager-Gruppe', 'Zeitstempel-Vertrauensanker']) {
    assert.equal(nach(erg, n).status, 'ok', n);
    assert.match(nach(erg, n).hinweis, /optional/, n);
  }
});

function ctMock() { return setupMockChurchTools('https://ct.example.org'); }

test('testeChurchtools: Namen und Mitgliederzahl', async () => {
  const pool = ctMock();
  for (const [id, name, n] of [['10', 'Buchhaltung', 2], ['20', 'Admin', 1], ['30', 'Manager', 0]]) {
    pool.intercept({ path: `/api/groups/${id}`, headers: { authorization: `Login ${GEHEIM}` } }).reply(200, { data: { id: Number(id), name } });
    pool.intercept({ path: `/api/groups/${id}/members` }).reply(200, { data: Array.from({ length: n }, (_, i) => ({ personId: i + 1 })) });
  }
  const erg = await testeChurchtools(configFuer('/x'));
  assert.equal(erg.ok, true);
  assert.deepEqual(erg.gruppen.map((g) => [g.rolle, g.id, g.name, g.mitglieder]), [
    ['Buchhaltung', '10', 'Buchhaltung', 2], ['Admin', '20', 'Admin', 1], ['Manager', '30', 'Manager', 0],
  ]);
});

test('testeChurchtools: 401 ergibt ok false ohne Token', async () => {
  ctMock().intercept({ path: /\/api\/groups\/.*/ }).reply(401, {}).persist();
  const erg = await testeChurchtools(configFuer('/x'));
  assert.equal(erg.ok, false);
  assert.ok(erg.meldung);
  assert.ok(!erg.meldung.includes(GEHEIM));
});

test('testeChurchtools: Netzfehler', async () => {
  ctMock().intercept({ path: /\/api\/groups\/.*/ }).replyWithError(new Error(`verbindung ${GEHEIM}`)).persist();
  const erg = await testeChurchtools(configFuer('/x'));
  assert.equal(erg.ok, false);
  assert.ok(!erg.meldung.includes(GEHEIM));
});

function stubMailer(fail = false) {
  const sent = [];
  return { sent, async sendMail(m) { if (fail) throw new Error('SMTP kaputt'); sent.push(m); } };
}
function dbMitPerson(t, email = 'a@example.org') {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  t.after(() => db.close());
  return db;
}

test('sendeTestmail: protokolliert testmail, sofort und fester Text', async (t) => {
  const db = dbMitPerson(t);
  const mailer = stubMailer();
  const erg = await sendeTestmail(db, mailer, { person: { email: 'a@example.org' } });
  assert.equal(erg.status, 'versendet');
  assert.equal(mailer.sent.length, 1);
  assert.equal(mailer.sent[0].subject, 'Testmail vom Freigabeportal');
  const row = db.prepare("SELECT typ, status, empfaenger FROM mail_log WHERE typ = 'testmail'").get();
  assert.deepEqual({ ...row }, { typ: 'testmail', status: 'versendet', empfaenger: 'a@example.org' });
});

test('sendeTestmail: Batching ändert nichts (immer sofort)', async (t) => {
  const db = dbMitPerson(t);
  db.prepare("INSERT OR REPLACE INTO admin_config (key, value) VALUES ('mail_batching_aktiv', '1')").run();
  const erg = await sendeTestmail(db, stubMailer(), { person: { email: 'a@example.org' } });
  assert.equal(erg.status, 'versendet');
});

test('sendeTestmail: ohne E-Mail-Adresse Meldung, kein Log', async (t) => {
  const db = dbMitPerson(t);
  const erg = await sendeTestmail(db, stubMailer(), { person: { email: '' } });
  assert.equal(erg.status, 'fehlgeschlagen');
  assert.match(erg.meldung, /E-Mail-Adresse/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM mail_log').get().n, 0);
});

test('sendeTestmail: SMTP-Fehler wird gemeldet', async (t) => {
  const db = dbMitPerson(t);
  const erg = await sendeTestmail(db, stubMailer(true), { person: { email: 'a@example.org' } });
  assert.notEqual(erg.status, 'versendet');
  assert.ok(erg.meldung);
});

test('loeseKernjobsAus: ruft Jobs, liefert Status je Job', async (t) => {
  const db = dbMitPerson(t);
  ctMock().intercept({ path: /\/api\/.*/ }).reply(500, {}).persist();
  const erg = await loeseKernjobsAus(db, configFuer('/x'), stubMailer(), ['sync-personen', 'pool-erinnerungen', 'mail-zustellung']);
  assert.deepEqual(erg.map((e) => e.job), ['sync-personen', 'pool-erinnerungen', 'mail-zustellung']);
  for (const e of erg) assert.equal(typeof e.status, 'string');
  assert.ok(db.prepare("SELECT 1 FROM cron_log WHERE job = 'pool-erinnerungen'").get());
  assert.ok(db.prepare('SELECT 1 FROM sync_log').get());
});

test('loeseKernjobsAus: unbekannter Job wird abgelehnt', async (t) => {
  const db = dbMitPerson(t);
  const erg = await loeseKernjobsAus(db, configFuer('/x'), stubMailer(), ['rm-rf']);
  assert.equal(erg[0].status, 'unbekannt');
});

test('Migration: bestehende DB ohne testmail wird erweitert, Daten und Index bleiben', () => {
  const dir = mkdtempSync(join(tmpdir(), 'testmail-schema-'));
  const pfad = join(dir, 'portal.db');
  let db = openDatabase(pfad);
  db.prepare(mailInsert('fehlermeldung')).run();
  db.close();
  const raw = new DatabaseSync(pfad);
  const sql = raw.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'mail_log'").get().sql;
  raw.exec('PRAGMA writable_schema = ON');
  raw.prepare("UPDATE sqlite_master SET sql = ? WHERE type = 'table' AND name = 'mail_log'").run(sql.replace(", 'testmail'", ''));
  raw.exec('PRAGMA writable_schema = OFF');
  raw.close();
  db = openDatabase(pfad);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM mail_log WHERE typ = 'fehlermeldung'").get().n, 1);
  assert.doesNotThrow(() => db.prepare(mailInsert('testmail')).run());
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'mail_log_zustellung_idx'").get());
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
