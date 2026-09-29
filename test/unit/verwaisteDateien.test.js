import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, symlinkSync, linkSync, mkdirSync, utimesSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { openDatabase } from '../../src/db/index.js';
import { createJob } from '../../src/db/jobsRepo.js';
import { startCronLauf } from '../../src/db/cronLogRepo.js';
import { writeFinalDocument } from '../../src/services/finalDocument.js';
import { withAuditActor } from '../../src/services/auditContext.js';
import {
  pruefeVerwaisteFinaleDateien, stelleQuarantaeneDateiWiederHer, loescheQuarantaeneDatei, QUARANTAENE_VERZEICHNIS,
} from '../../src/services/verwaisteDateien.js';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const SOFORT = { mindestAlterMs: 0 };

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'verwaist-'));
  const jobsDir = join(dir, 'jobs');
  mkdirSync(jobsDir);
  const db = openDatabase(':memory:');
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const quelle = join(jobsDir, 'job-1.pdf');
  writeFileSync(quelle, '%PDF-quelle');
  const jobId = createJob(db, { eingangAm: '2026-09-29T00:00:00Z', quelle: 'scanner', dateiname: 'a.pdf', pdfPfad: quelle });
  return { db, dir, jobsDir, config: { jobsDir }, quelle, jobId };
}

function altern(pfad, stunden = 48) {
  const zeit = new Date(Date.now() - stunden * 3600 * 1000);
  utimesSync(pfad, zeit, zeit);
}

const quarantaeneDateien = (jobsDir) => readdirSync(join(jobsDir, QUARANTAENE_VERZEICHNIS));

test('abort before commit leaves an unreferenced file that is quarantined only after the minimum age', (t) => {
  const { db, jobsDir, config, quelle } = setup(t);
  const verwaist = writeFinalDocument(quelle, Buffer.from('%PDF-final-abgebrochen'));
  let ergebnis = pruefeVerwaisteFinaleDateien(db, config);
  assert.equal(ergebnis.zuJung, 1);
  assert.equal(existsSync(verwaist), true);
  altern(verwaist);
  ergebnis = withAuditActor({ id: 'system', name: 'System' }, () => pruefeVerwaisteFinaleDateien(db, config));
  assert.equal(ergebnis.verschoben, 1);
  assert.equal(existsSync(verwaist), false);
  const ziel = join(jobsDir, QUARANTAENE_VERZEICHNIS, basename(verwaist));
  assert.equal(readFileSync(ziel, 'utf8'), '%PDF-final-abgebrochen');
  const row = db.prepare('SELECT * FROM datei_quarantaene').get();
  assert.equal(row.sha256, sha('%PDF-final-abgebrochen'));
  assert.equal(row.status, 'quarantaene');
  const event = db.prepare("SELECT * FROM audit_ereignisse WHERE aktion = 'verwaiste_datei_in_quarantaene'").get();
  assert.equal(event.objekt_id, String(row.id));
  assert.ok(!event.nachher.includes(jobsDir));
  // Wiederanlauf: idempotent, nichts Neues.
  assert.equal(pruefeVerwaisteFinaleDateien(db, config, SOFORT).verschoben, 0);
  assert.deepEqual(quarantaeneDateien(jobsDir), [basename(verwaist)]);
});

test('file referenced after commit, in snapshots/manifests or audit history, or with a known hash stays in place', (t) => {
  const { db, jobsDir, config, quelle, jobId } = setup(t);
  const committed = writeFinalDocument(quelle, Buffer.from('%PDF-committed'));
  db.prepare('UPDATE jobs SET pdf_pfad = ? WHERE id = ?').run(committed, jobId);
  const imSnapshot = writeFinalDocument(quelle, Buffer.from('%PDF-snapshot'));
  db.prepare('UPDATE jobs SET freigabe_snapshot = ? WHERE id = ?').run(JSON.stringify({ datei: basename(imSnapshot) }), jobId);
  const historisch = writeFinalDocument(quelle, Buffer.from('%PDF-historisch'));
  db.prepare(`INSERT INTO audit_ereignisse (zeitpunkt, person_id, person_name, objekt, objekt_id, aktion, vorher)
    VALUES ('2026-01-01', 'system', 'System', 'jobs', '1', 'UPDATE', ?)`).run(JSON.stringify({ pdf_pfad: historisch }));
  const bekannt = writeFinalDocument(quelle, Buffer.from('%PDF-bekannt'));
  db.prepare('UPDATE jobs SET final_datei_hash = ? WHERE id = ?').run(sha('%PDF-bekannt'), jobId);
  for (const pfad of [committed, imSnapshot, historisch, bekannt]) altern(pfad);
  const ergebnis = pruefeVerwaisteFinaleDateien(db, config);
  assert.deepEqual([ergebnis.referenziert, ergebnis.historisch, ergebnis.hashBekannt, ergebnis.verschoben], [2, 1, 1, 0]);
  for (const pfad of [committed, imSnapshot, historisch, bekannt]) assert.equal(existsSync(pfad), true);
});

test('a finalisation committing concurrently between listing and move keeps the file', (t) => {
  const { db, config, quelle, jobId } = setup(t);
  const datei = writeFinalDocument(quelle, Buffer.from('%PDF-parallel'));
  altern(datei);
  const ergebnis = pruefeVerwaisteFinaleDateien(db, config, {
    vorTransaktion: () => db.prepare('UPDATE jobs SET pdf_pfad = ? WHERE id = ?').run(datei, jobId),
  });
  assert.equal(ergebnis.referenziert, 1);
  assert.equal(existsSync(datei), true);
  assert.equal(db.prepare('SELECT count(*) AS n FROM datei_quarantaene').get().n, 0);
});

test('running retry jobs, non-regular files and symlinked directories are never touched', (t) => {
  const { db, dir, jobsDir, config } = setup(t);
  const fremd = join(dir, 'fremd.pdf');
  writeFileSync(fremd, 'ausserhalb');
  const link = join(jobsDir, `final-${randomUUID()}.pdf`);
  symlinkSync(fremd, link);
  mkdirSync(join(jobsDir, `final-${randomUUID()}.pdf`));
  const ergebnis = pruefeVerwaisteFinaleDateien(db, config, SOFORT);
  assert.equal(ergebnis.keineRegulaereDatei, 2);
  assert.equal(readFileSync(fremd, 'utf8'), 'ausserhalb');
  assert.equal(existsSync(link), true);

  const lauf = startCronLauf(db, 'zeitstempel-nachholen');
  assert.equal(pruefeVerwaisteFinaleDateien(db, config, SOFORT).status, 'uebersprungen');
  db.prepare("UPDATE cron_log SET status = 'erfolg', beendet_am = ? WHERE id = ?").run(new Date().toISOString(), lauf);

  const qdir = join(jobsDir, QUARANTAENE_VERZEICHNIS);
  rmSync(qdir, { recursive: true });
  mkdirSync(join(dir, 'anderswo'));
  symlinkSync(join(dir, 'anderswo'), qdir);
  assert.throws(() => pruefeVerwaisteFinaleDateien(db, config, SOFORT), /Symlink/);
  const jobsLink = join(dir, 'jobs-link');
  symlinkSync(jobsDir, jobsLink);
  assert.throws(() => pruefeVerwaisteFinaleDateien(db, { jobsDir: jobsLink }, SOFORT), /Symlink/);
  assert.deepEqual(readdirSync(join(dir, 'anderswo')), []);
});

test('database failure during quarantine leaves the file at its original location', (t) => {
  const { db, jobsDir, config, quelle } = setup(t);
  const datei = writeFinalDocument(quelle, Buffer.from('%PDF-dbfehler'));
  altern(datei);
  db.exec("CREATE TRIGGER audit_ausfall BEFORE INSERT ON audit_ereignisse WHEN NEW.aktion = 'verwaiste_datei_in_quarantaene' BEGIN SELECT RAISE(ABORT, 'audit down'); END;");
  const originalError = console.error;
  console.error = () => {};
  let ergebnis;
  try { ergebnis = pruefeVerwaisteFinaleDateien(db, config); } finally { console.error = originalError; }
  assert.equal(ergebnis.fehler, 1);
  assert.equal(existsSync(datei), true);
  assert.deepEqual(quarantaeneDateien(jobsDir), []);
  assert.equal(db.prepare('SELECT count(*) AS n FROM datei_quarantaene').get().n, 0);
  assert.equal(db.isTransaction, false);
  // Unreadable database state (closed connection) must not remove anything either.
  db.exec('DROP TRIGGER audit_ausfall');
  const kaputt = openDatabase(':memory:');
  kaputt.close();
  assert.throws(() => pruefeVerwaisteFinaleDateien(kaputt, config));
  assert.equal(existsSync(datei), true);
});

test('restart after a crash between link and commit completes the quarantine without data loss', (t) => {
  const { db, jobsDir, config, quelle } = setup(t);
  const datei = writeFinalDocument(quelle, Buffer.from('%PDF-halb'));
  altern(datei);
  mkdirSync(join(jobsDir, QUARANTAENE_VERZEICHNIS), { mode: 0o700 });
  linkSync(datei, join(jobsDir, QUARANTAENE_VERZEICHNIS, basename(datei)));
  assert.equal(pruefeVerwaisteFinaleDateien(db, config).verschoben, 1);
  assert.equal(existsSync(datei), false);
  assert.equal(readFileSync(join(jobsDir, QUARANTAENE_VERZEICHNIS, basename(datei)), 'utf8'), '%PDF-halb');
  // A different file already occupying the quarantine name blocks the move.
  const zweite = writeFinalDocument(quelle, Buffer.from('%PDF-zweite'));
  altern(zweite);
  writeFileSync(join(jobsDir, QUARANTAENE_VERZEICHNIS, basename(zweite)), 'fremd');
  const originalError = console.error;
  console.error = () => {};
  try { assert.equal(pruefeVerwaisteFinaleDateien(db, config).fehler, 1); } finally { console.error = originalError; }
  assert.equal(readFileSync(zweite, 'utf8'), '%PDF-zweite');
});

test('explicit decisions: restore or delete with reason, hash check, conflicts and immutability', (t) => {
  const { db, jobsDir, config, quelle } = setup(t);
  const a = writeFinalDocument(quelle, Buffer.from('%PDF-a'));
  const b = writeFinalDocument(quelle, Buffer.from('%PDF-b'));
  altern(a); altern(b);
  pruefeVerwaisteFinaleDateien(db, config);
  const [idA, idB] = db.prepare('SELECT id FROM datei_quarantaene ORDER BY dateiname').all()
    .map((row) => row.id).sort((x, y) => x - y);
  const eintrag = (id) => db.prepare('SELECT * FROM datei_quarantaene WHERE id = ?').get(id);
  const qpfad = (id) => join(jobsDir, QUARANTAENE_VERZEICHNIS, eintrag(id).dateiname);
  assert.throws(() => stelleQuarantaeneDateiWiederHer(db, config, idA, 'kurz'), (err) => err.status === 400);

  // Restore refuses to overwrite an existing file of the same name.
  writeFileSync(join(jobsDir, eintrag(idA).dateiname), 'belegt');
  assert.throws(() => stelleQuarantaeneDateiWiederHer(db, config, idA, 'Datei wird doch benoetigt'), (err) => err.status === 409);
  assert.equal(eintrag(idA).status, 'quarantaene');
  assert.equal(existsSync(qpfad(idA)), true);
  rmSync(join(jobsDir, eintrag(idA).dateiname));
  withAuditActor({ id: '99', name: 'Admin' }, () => stelleQuarantaeneDateiWiederHer(db, config, idA, 'Datei wird doch benoetigt'));
  assert.equal(eintrag(idA).status, 'wiederhergestellt');
  assert.equal(eintrag(idA).entschieden_von, '99');
  assert.equal(existsSync(join(jobsDir, eintrag(idA).dateiname)), true);
  assert.throws(() => loescheQuarantaeneDatei(db, config, idA, 'Zweite Entscheidung'), (err) => err.status === 409);

  // Tampered quarantine file is not deleted.
  const original = readFileSync(qpfad(idB));
  writeFileSync(qpfad(idB), 'manipuliert');
  assert.throws(() => loescheQuarantaeneDatei(db, config, idB, 'Verwaiste Datei nach Pruefung entfernen'), (err) => err.status === 409);
  assert.equal(existsSync(qpfad(idB)), true);
  writeFileSync(qpfad(idB), original);
  withAuditActor({ id: '99', name: 'Admin' }, () => loescheQuarantaeneDatei(db, config, idB, 'Verwaiste Datei nach Pruefung entfernen'));
  assert.equal(existsSync(qpfad(idB)), false);
  assert.equal(eintrag(idB).status, 'geloescht');
  const aktionen = db.prepare("SELECT aktion FROM audit_ereignisse WHERE objekt = 'datei_quarantaene' AND objekt_id = ? ORDER BY id").all(String(idB)).map((r) => r.aktion);
  assert.deepEqual(aktionen, ['verwaiste_datei_in_quarantaene', 'datei_loeschung_beabsichtigt', 'datei_geloescht', 'quarantaene_datei_geloescht']);
  assert.throws(() => db.prepare("UPDATE datei_quarantaene SET sha256 = ? WHERE id = ?").run('0'.repeat(64), idB), /unveraenderlich/);
  assert.throws(() => db.prepare('DELETE FROM datei_quarantaene WHERE id = ?').run(idB), /unveraenderlich/);
  assert.throws(() => db.prepare("UPDATE datei_quarantaene SET status = 'quarantaene', entschieden_von = 'x', entschieden_am = 'x', begruendung = 'x' WHERE id = ?").run(idA), /unveraenderlich/);
});

test('a quarantined file that becomes referenced again cannot be deleted', (t) => {
  const { db, config, quelle, jobId } = setup(t);
  const datei = writeFinalDocument(quelle, Buffer.from('%PDF-wieder'));
  altern(datei);
  pruefeVerwaisteFinaleDateien(db, config);
  const { id, dateiname } = db.prepare('SELECT id, dateiname FROM datei_quarantaene').get();
  db.prepare('UPDATE jobs SET freigabe_snapshot = ? WHERE id = ?').run(JSON.stringify({ datei: dateiname }), jobId);
  assert.throws(() => loescheQuarantaeneDatei(db, config, id, 'Loeschen trotz Referenz versucht'), (err) => err.status === 409);
});
