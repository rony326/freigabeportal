import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openDatabase } from '../../src/db/index.js';
import { seedDefaults, setConfigValue, getConfigValue } from '../../src/db/adminConfigRepo.js';
import { erstelleSpielwiese, entferneSpielwiese, testmodusPfade } from '../../src/services/testmodus/spielwiese.js';

function umgebung() {
  const dir = mkdtempSync(join(tmpdir(), 'testmodus-'));
  const config = {
    dbPath: join(dir, 'echt.sqlite'), jobsDir: join(dir, 'jobs'), brandingDir: join(dir, 'branding'),
    n8nApiKey: 'n'.repeat(32), cronSecret: 'c'.repeat(32), backupApiKey: 'b'.repeat(32),
    churchtools: { baseUrl: 'https://echt.example', syncServiceToken: 't'.repeat(32), groupIdAdmin: '1', groupIdBuchhaltung: '2', clientSecret: 's'.repeat(32) },
  };
  mkdirSync(config.brandingDir);
  writeFileSync(join(config.brandingDir, 'logo.png'), 'x');
  const db = openDatabase(config.dbPath);
  seedDefaults(db);
  setConfigValue(db, 'footer_text', 'Echter Footer');
  setConfigValue(db, 'smtp_passwort', 'geheim');
  setConfigValue(db, 'api_token_x', 'geheim');
  setConfigValue(db, 'zeitstempel_tsa_url', 'https://tsa.example');
  setConfigValue(db, 'monitoring_secret', 'm');
  setConfigValue(db, 'einrichtung_abgeschlossen_am', 'heute');
  return { dir, config, db };
}
const zeilen = (db) => ['personen', 'jobs', 'konten', 'admin_config'].map((t) => db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c);

test('erstellt DB, Verzeichnisse, Beispieldaten', async () => {
  const { config, db } = umgebung();
  const sp = await erstelleSpielwiese(db, config);
  const p = testmodusPfade(config);
  assert.ok(existsSync(p.dbPath) && existsSync(p.jobsDir));
  assert.ok(existsSync(join(p.brandingDir, 'logo.png')));
  assert.equal(sp.db.prepare('SELECT COUNT(*) c FROM personen').get().c, 5);
  assert.equal(sp.db.prepare('SELECT COUNT(*) c FROM konten').get().c, 2);
  assert.equal(sp.db.prepare('SELECT COUNT(*) c FROM kreditoren').get().c, 2);
  const status = sp.db.prepare("SELECT status, COUNT(*) c FROM jobs WHERE quelle != 'spesen' GROUP BY status").all().map((r) => r.status).sort();
  assert.deepEqual(status, ['abgelehnt', 'abgeschlossen', 'freigabe2', 'unzugewiesen', 'zugewiesen']);
  assert.equal(sp.db.prepare("SELECT COUNT(*) c FROM jobs WHERE quelle = 'spesen'").get().c, 1);
  assert.equal(sp.db.prepare("SELECT COUNT(*) c FROM freigaben WHERE rolle = 'freigeber1'").get().c, 3);
  assert.ok(readdirSync(p.jobsDir).filter((f) => f.endsWith('.pdf')).length >= 6);
  assert.equal(sp.db.prepare("SELECT email FROM personen WHERE churchtools_person_id='test-1'").get().email, 'anna@beispiel.invalid');
  sp.db.close(); db.close();
});

test('kopiert Einstellungen ohne Geheimnisse und ohne TSA/Monitoring/Einrichtung', async () => {
  const { config, db } = umgebung();
  const sp = await erstelleSpielwiese(db, config);
  assert.equal(getConfigValue(sp.db, 'footer_text'), 'Echter Footer');
  assert.equal(getConfigValue(sp.db, 'smtp_passwort'), null);
  assert.equal(getConfigValue(sp.db, 'api_token_x'), null);
  assert.equal(getConfigValue(sp.db, 'zeitstempel_tsa_url'), '');
  assert.equal(getConfigValue(sp.db, 'monitoring_secret'), null);
  assert.equal(getConfigValue(sp.db, 'einrichtung_abgeschlossen_am'), null);
  sp.db.close(); db.close();
});

test('testConfig ohne Token/URLs', async () => {
  const { config, db } = umgebung();
  const sp = await erstelleSpielwiese(db, config);
  const c = sp.config;
  assert.equal(c.n8nApiKey, null);
  assert.equal(c.cronSecret, null);
  assert.equal(c.backupApiKey, null);
  assert.equal(c.churchtools.syncServiceToken, null);
  assert.equal(c.churchtools.baseUrl, 'https://testmodus.invalid');
  assert.equal(c.churchtools.groupIdAdmin, 'test-admin');
  assert.equal(c.churchtools.groupIdBuchhaltung, 'test-buchhaltung');
  assert.equal(c.dbPath, testmodusPfade(config).dbPath);
  assert.equal(config.n8nApiKey.length, 32);
  sp.db.close(); db.close();
});

test('neu=true setzt zurück, ohne neu bleibt Zusatzdaten', async () => {
  const { config, db } = umgebung();
  let sp = await erstelleSpielwiese(db, config);
  sp.db.prepare("INSERT INTO kreditoren (name, aktiv) VALUES ('Eigener', 1)").run();
  sp.db.close();
  sp = await erstelleSpielwiese(db, config);
  assert.equal(sp.db.prepare('SELECT COUNT(*) c FROM kreditoren').get().c, 3);
  sp.db.close();
  sp = await erstelleSpielwiese(db, config, { neu: true });
  assert.equal(sp.db.prepare('SELECT COUNT(*) c FROM kreditoren').get().c, 2);
  assert.equal(sp.db.prepare('SELECT COUNT(*) c FROM personen').get().c, 5);
  sp.db.close(); db.close();
});

test('beschädigte Datei wird neu erstellt', async () => {
  const { config, db } = umgebung();
  const p = testmodusPfade(config);
  writeFileSync(p.dbPath, 'das ist keine datenbank, nur muell '.repeat(50));
  const sp = await erstelleSpielwiese(db, config);
  assert.equal(sp.db.prepare('SELECT COUNT(*) c FROM personen').get().c, 5);
  sp.db.close(); db.close();
});

test('echte DB unverändert, entferneSpielwiese räumt auf', async () => {
  const { config, db } = umgebung();
  const vorher = zeilen(db);
  const sp = await erstelleSpielwiese(db, config, { neu: true });
  sp.db.close();
  assert.deepEqual(zeilen(db), vorher);
  assert.equal(existsSync(config.jobsDir), false);
  entferneSpielwiese(config);
  const p = testmodusPfade(config);
  assert.equal(existsSync(p.dbPath), false);
  assert.equal(existsSync(p.jobsDir), false);
  assert.equal(existsSync(p.brandingDir), false);
  db.close();
});

test('Logo-Pfade zeigen in die Kopie, echtes Logo bleibt', async () => {
  const { config, db } = umgebung();
  setConfigValue(db, 'branding_logo_pfad', join(config.brandingDir, 'logo.png'));
  setConfigValue(db, 'branding_logo_mimetype', 'image/png');
  setConfigValue(db, 'branding_logo_dunkel_pfad', join(config.brandingDir, 'fehlt.png'));
  setConfigValue(db, 'branding_logo_dunkel_mimetype', 'image/png');
  const sp = await erstelleSpielwiese(db, config);
  const pfad = getConfigValue(sp.db, 'branding_logo_pfad');
  assert.ok(pfad.startsWith(`${config.brandingDir}-testmodus`));
  unlinkSync(pfad);
  assert.ok(existsSync(join(config.brandingDir, 'logo.png')));
  assert.equal(getConfigValue(sp.db, 'branding_logo_dunkel_pfad'), null);
  assert.equal(getConfigValue(sp.db, 'branding_logo_dunkel_mimetype'), null);
  sp.db.close(); db.close();
});

test('kein SMTP, :memory: abgelehnt', async () => {
  const { config, db } = umgebung();
  const sp = await erstelleSpielwiese(db, config);
  assert.equal(sp.config.smtp, null);
  sp.db.close(); db.close();
  assert.throws(() => testmodusPfade({ dbPath: ':memory:' }), /Datei-Datenbank/);
});

test('unvollständige Spielwiese (ohne Bereit-Marker) wird neu erstellt', async () => {
  const { config, db } = umgebung();
  let sp = await erstelleSpielwiese(db, config);
  sp.db.prepare("DELETE FROM admin_config WHERE key = 'testmodus_bereit'").run();
  sp.db.prepare("INSERT INTO kreditoren (name, aktiv) VALUES ('Rest', 1)").run();
  sp.db.close();
  sp = await erstelleSpielwiese(db, config);
  assert.equal(sp.db.prepare('SELECT COUNT(*) c FROM kreditoren').get().c, 2);
  assert.equal(getConfigValue(sp.db, 'testmodus_bereit'), '1');
  sp.db.close(); db.close();
});

test('vorhandene Spielwiese erhält beim Wiederöffnen fehlende Standardwerte (App-Update), eigene Werte bleiben', async () => {
  const { config, db } = umgebung();
  let sp = await erstelleSpielwiese(db, config);
  sp.db.prepare("DELETE FROM admin_config WHERE key IN ('kk_beleg_erinnerung_tage', 'mail_vorlage_kk_abrechnung_zugewiesen_betreff')").run();
  setConfigValue(sp.db, 'footer_text', 'In der Spielwiese geändert');
  sp.db.prepare("INSERT INTO kreditoren (name, aktiv) VALUES ('Eigener', 1)").run();
  sp.db.close();
  sp = await erstelleSpielwiese(db, config);
  assert.equal(getConfigValue(sp.db, 'kk_beleg_erinnerung_tage'), '45');
  assert.equal(getConfigValue(sp.db, 'mail_vorlage_kk_abrechnung_zugewiesen_betreff'), 'Freigabeportal: Kreditkartenabrechnung zum Abgleich');
  assert.equal(getConfigValue(sp.db, 'footer_text'), 'In der Spielwiese geändert');
  assert.equal(sp.db.prepare('SELECT COUNT(*) c FROM kreditoren').get().c, 3, 'wiedergeöffnet, nicht neu erstellt');
  sp.db.close(); db.close();
});

test('Pfade mit Schrägstrich am Ende: Spielwiese liegt neben, nie in den echten Verzeichnissen', async () => {
  const { dir, config, db } = umgebung();
  const mitSlash = { ...config, jobsDir: `${config.jobsDir}/`, brandingDir: `${config.brandingDir}//`, dbPath: config.dbPath };
  const p = testmodusPfade(mitSlash);
  assert.equal(p.jobsDir, join(dir, 'jobs-testmodus'));
  assert.equal(p.brandingDir, join(dir, 'branding-testmodus'));
  assert.equal(p.dbPath, `${config.dbPath}.testmodus.db`);
  const sp = await erstelleSpielwiese(db, mitSlash);
  assert.ok(existsSync(join(dir, 'jobs-testmodus')));
  assert.ok(existsSync(join(dir, 'branding-testmodus', 'logo.png')));
  assert.deepEqual(readdirSync(config.brandingDir), ['logo.png'], 'nichts im echten Branding-Verzeichnis');
  assert.equal(existsSync(config.jobsDir) && readdirSync(config.jobsDir).length > 0, false, 'nichts im echten Belegverzeichnis');
  sp.db.close(); db.close();
});

test('relative Pfade werden absolut aufgelöst', () => {
  const p = testmodusPfade({ dbPath: 'data/portal.sqlite', jobsDir: './data/jobs/', brandingDir: 'data/branding' });
  assert.equal(p.jobsDir, resolve('data/jobs-testmodus'));
  assert.equal(p.brandingDir, resolve('data/branding-testmodus'));
  assert.equal(p.dbPath, resolve('data/portal.sqlite.testmodus.db'));
  assert.equal(p.backupDir, resolve('data/portal.sqlite.testmodus-backups'));
});
