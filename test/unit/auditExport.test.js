import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openDatabase } from '../../src/db/index.js';
import { auditRequestContext, withAuditActor } from '../../src/services/auditContext.js';
import {
  erstelleAuditExportPaket, ladeAuditExportPaket, pruefeAuditExportRegister, pruefeAuditExportPaket, ausstehendeAuditEreignisse,
} from '../../src/services/auditExport.js';

function ereignis(db, aktion = 'test') {
  return Number(db.prepare(`INSERT INTO audit_ereignisse (zeitpunkt, person_id, person_name, objekt, objekt_id, aktion, nachher)
    VALUES ('2026-09-29T00:00:00Z', 'system', 'System', 'test', '1', ?, '{"a":1}')`).run(aktion).lastInsertRowid);
}

function setup(t) {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  return db;
}

test('packages are contiguous, chained, deterministic and include request correlation', (t) => {
  const db = setup(t);
  // Schema migration itself writes no audit events, so the export starts at the first event.
  const basis = ausstehendeAuditEreignisse(db);
  auditRequestContext({}, { setHeader() {} }, () => withAuditActor({ id: '7', name: 'Ada' }, () => ereignis(db, 'mit_request')));
  for (let i = 0; i < 4; i++) ereignis(db);
  const erstes = erstelleAuditExportPaket(db, { maxEreignisse: basis + 3 });
  assert.equal(erstes.manifest.paketNr, 1);
  assert.equal(erstes.manifest.vonId, 1);
  assert.equal(erstes.manifest.vorgaengerPaketSha256, null);
  assert.deepEqual(pruefeAuditExportPaket(erstes.manifest, erstes.inhalt), []);
  const zeile = erstes.inhalt.split('\n').map((z) => z && JSON.parse(z)).find((z) => z?.aktion === 'mit_request');
  assert.match(zeile.request_id, /^[0-9a-f-]{36}$/);
  const zweites = erstelleAuditExportPaket(db);
  assert.equal(zweites.manifest.vonId, erstes.manifest.bisId + 1);
  assert.equal(zweites.manifest.vorgaengerPaketSha256, erstes.manifest.paketSha256);
  assert.deepEqual(pruefeAuditExportPaket(zweites.manifest, zweites.inhalt, erstes.manifest), []);
  assert.equal(erstelleAuditExportPaket(db), null);
  assert.equal(ausstehendeAuditEreignisse(db), 0);
  // Re-rendering a registered package yields byte-identical output.
  assert.deepEqual(ladeAuditExportPaket(db, 1), erstes);
  assert.deepEqual(pruefeAuditExportRegister(db), { pakete: 2, ausstehend: 0, befunde: [] });
  assert.throws(() => db.exec('DELETE FROM audit_export_pakete'), /unveraenderlich/);
  assert.throws(() => erstelleAuditExportPaket(db, { maxEreignisse: 0 }), /Paketgroesse/);
});

test('local tampering after export is reported, but only relative to the local register', (t) => {
  const db = setup(t);
  for (let i = 0; i < 3; i++) ereignis(db);
  const paket = erstelleAuditExportPaket(db);
  db.exec('DROP TRIGGER audit_no_update');
  db.prepare("UPDATE audit_ereignisse SET aktion = 'veraendert' WHERE id = 2").run();
  assert.deepEqual(pruefeAuditExportRegister(db).befunde, [{ paketNr: 1, befund: 'inhalt_abweichend' }]);
  assert.throws(() => ladeAuditExportPaket(db, 1), /weichen/);
  // A receiver holding the original package detects modified or shortened content independently.
  assert.deepEqual(pruefeAuditExportPaket(paket.manifest, paket.inhalt.replace('"test"', '"x"')), ['inhalt_hash_abweichend']);
  const ohneZeile = paket.inhalt.split('\n').filter((_, i) => i !== 1).join('\n');
  assert.ok(pruefeAuditExportPaket(paket.manifest, ohneZeile).includes('anzahl_abweichend'));
  const gefaelscht = { ...paket.manifest, anzahl: 2 };
  assert.ok(pruefeAuditExportPaket(gefaelscht, paket.inhalt).includes('paket_hash_abweichend'));
});

test('deleted audit rows show up as gaps in the next package and a broken chain is detected', (t) => {
  const db = setup(t);
  for (let i = 0; i < 5; i++) ereignis(db);
  db.exec('DROP TRIGGER audit_no_delete');
  db.prepare('DELETE FROM audit_ereignisse WHERE id IN (2, 3)').run();
  const paket = erstelleAuditExportPaket(db);
  assert.deepEqual(paket.manifest.luecken, [[2, 3]]);
  assert.deepEqual(pruefeAuditExportPaket(paket.manifest, paket.inhalt), []);
  ereignis(db);
  const naechstes = erstelleAuditExportPaket(db);
  const fremd = { ...paket.manifest, paketSha256: '0'.repeat(64) };
  assert.ok(pruefeAuditExportPaket(naechstes.manifest, naechstes.inhalt, fremd).includes('kette_unterbrochen'));
});

test('CLI writes the package pair exclusively with mode 0600 and verifies the register', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-export-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, 'db.sqlite');
  const db = openDatabase(dbPath);
  ereignis(db);
  db.close();
  const env = { ...process.env, DB_PATH: dbPath };
  const cli = (...args) => execFileSync(process.execPath, ['src/cli/auditExport.js', ...args], { env, encoding: 'utf8' });
  const out = join(dir, 'out');
  execFileSync('mkdir', [out]);
  const result = JSON.parse(cli('export', '--out', out));
  assert.equal(result.exportiert, 1);
  const dateien = readdirSync(out).sort();
  assert.deepEqual(dateien, ['audit-export-00000001.jsonl', 'audit-export-00000001.manifest.json']);
  for (const datei of dateien) assert.equal(statSync(join(out, datei)).mode & 0o777, 0o600);
  const manifest = JSON.parse(readFileSync(join(out, dateien[1]), 'utf8'));
  assert.deepEqual(pruefeAuditExportPaket(manifest, readFileSync(join(out, dateien[0]), 'utf8')), []);
  // Re-exporting the same package never overwrites existing files.
  assert.throws(() => cli('export', '--out', out, '--paket', '1'), /EEXIST|Command failed/);
  assert.deepEqual(JSON.parse(cli('verify')).befunde, []);
});
