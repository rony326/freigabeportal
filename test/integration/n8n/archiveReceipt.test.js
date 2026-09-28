import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../../src/db/index.js';
import { createJob, getJobById } from '../../../src/db/jobsRepo.js';
import { seedDefaults, setConfigValue } from '../../../src/db/adminConfigRepo.js';
import { requireApiKey } from '../../../src/middleware/apiKey.js';
import { createN8nJobsRouter } from '../../../src/routes/n8n/jobs.js';
import { runPdfBereinigungJob } from '../../../src/services/cronJobs.js';
import { ARCHIVE_RETENTION_MS } from '../../../src/services/archiveReceipt.js';

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'archive-receipt-'));
  const db = openDatabase(':memory:');
  seedDefaults(db);
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const config = { jobsDir: dir, n8nApiKey: 'workflow-key' };
  const app = express();
  app.use('/api/n8n/jobs', requireApiKey(config), createN8nJobsRouter({ db, config }));
  function job(name = 'invoice', groupParent = null) {
    const path = join(dir, `${name}.pdf`);
    const bytes = Buffer.from(`%PDF-1.4\n${name}\n`);
    writeFileSync(path, bytes);
    const id = createJob(db, { eingangAm: '2026-09-27T00:00:00Z', quelle: 'scanner', dateiname: `${name}.pdf`, pdfPfad: path });
    const hash = createHash('sha256').update(bytes).digest('hex');
    db.prepare("UPDATE jobs SET status = 'abgeschlossen', final_datei_hash = ?, aufgesplittet_von = ? WHERE id = ?").run(hash, groupParent, id);
    return { id, path, hash };
  }
  const get = (id) => request(app).get(`/api/n8n/jobs/${id}/exportnachweis`).set('X-API-Key', 'workflow-key');
  const post = (id, body) => request(app).post(`/api/n8n/jobs/${id}/archivierung-bestaetigen`).set('X-API-Key', 'workflow-key').send(body);
  const receipt = (manifest, dokument_id = 42) => ({ export_id: manifest.export_id, sha256: manifest.sha256, dokument_id, task_id: 'b2ba769c-455f-4d97-9fb6-986eac19a334' });
  return { db, dir, config, app, job, get, post, receipt };
}

test('manifest requires authentication, freezes the export hash and records n8n as actor', async (t) => {
  const s = setup(t);
  const j = s.job();
  assert.equal((await request(s.app).get(`/api/n8n/jobs/${j.id}/exportnachweis`)).status, 401);
  const first = await s.get(j.id);
  assert.equal(first.status, 200);
  assert.equal(first.body.sha256, j.hash);
  assert.equal(first.body.version, 1);
  const download = await request(s.app).get(first.body.download_pfad).set('X-API-Key', 'workflow-key');
  assert.equal(download.status, 200);
  assert.equal(createHash('sha256').update(download.body).digest('hex'), j.hash);
  assert.equal((await request(s.app).get(first.body.download_pfad)).status, 401);
  assert.equal(first.body.metadaten.nachweis_status, 'historisch_unvollstaendig');
  assert.deepEqual((await s.get(j.id)).body, first.body);
  const event = s.db.prepare("SELECT * FROM audit_ereignisse WHERE objekt = 'export_nachweise'").get();
  assert.equal(event.person_id, 'service:n8n');
  assert.throws(() => s.db.exec("UPDATE export_nachweise SET sha256 = 'forged'"), /unveraenderlich/);
  assert.throws(() => s.db.exec('DELETE FROM export_nachweise'), /unveraenderlich/);
});

test('wrong, missing and cross-job receipt evidence never changes state or deletes files', async (t) => {
  const s = setup(t);
  const j = s.job();
  const other = s.job('other');
  const manifest = (await s.get(j.id)).body;
  for (const [body, status] of [[{}, 400], [{ ...s.receipt(manifest), sha256: '0'.repeat(64) }, 409], [{ ...s.receipt(manifest), dokument_id: -1 }, 400], [{ ...s.receipt(manifest), task_id: 'pending' }, 400], [{ ...s.receipt(manifest), sha256: [manifest.sha256] }, 400]]) {
    assert.equal((await s.post(j.id, body)).status, status);
  }
  assert.equal((await s.post(other.id, s.receipt(manifest))).status, 409);
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM archiv_quittungen').get().n, 0);
  assert.equal(getJobById(s.db, j.id).status, 'abgeschlossen');
  assert.ok(existsSync(j.path));
  assert.equal((await s.get('NaN')).status, 400);
  assert.equal((await s.get(99999)).status, 404);
});

test('receipt is immutable, idempotent and retains local bytes for seven days', async (t) => {
  const s = setup(t);
  const j = s.job();
  const manifest = (await s.get(j.id)).body;
  const body = s.receipt(manifest);
  const first = await s.post(j.id, body);
  assert.equal(first.status, 200);
  assert.equal(first.body.status, 'archiv_bestaetigt');
  assert.deepEqual((await s.post(j.id, body)).body, first.body);
  assert.equal((await s.post(j.id, { ...body, dokument_id: 43 })).status, 409);
  assert.equal(getJobById(s.db, j.id).status, 'abgeholt');
  assert.throws(() => s.db.exec('DELETE FROM archiv_quittungen'), /unveraenderlich/);
  assert.throws(() => s.db.exec("UPDATE archiv_quittungen SET bestaetigt_am = '2000-01-01'"), /unveraenderlich/);
  assert.equal(runPdfBereinigungJob(s.db, s.config).archiviert, 0);
  assert.ok(existsSync(j.path));
  const confirmedAt = Date.parse(first.body.quittung.bestaetigt_am);
  t.mock.method(Date, 'now', () => confirmedAt + ARCHIVE_RETENTION_MS - 1);
  assert.equal(runPdfBereinigungJob(s.db, s.config).archiviert, 0);
  t.mock.method(Date, 'now', () => confirmedAt + ARCHIVE_RETENTION_MS);
  assert.equal(runPdfBereinigungJob(s.db, s.config).archiviert, 1);
  assert.equal(existsSync(j.path), false);
  assert.equal(runPdfBereinigungJob(s.db, s.config).archiviert, 0);
  assert.deepEqual((await s.post(j.id, body)).body, first.body);
  assert.deepEqual((await s.get(j.id)).body, manifest);
  assert.equal((await request(s.app).get(manifest.download_pfad).set('X-API-Key', 'workflow-key')).status, 409);
});

test('legacy ACK retains files through cleanup and accepts a later archive receipt', async (t) => {
  const s = setup(t);
  const j = s.job();
  const ack = await request(s.app).post(`/api/n8n/jobs/${j.id}/abholung-bestaetigen`).set('X-API-Key', 'workflow-key');
  assert.equal(ack.status, 200);
  assert.equal(ack.body.archiv_bestaetigt, false);
  const pending = () => request(s.app).get('/api/n8n/jobs/archivierung-ausstehend').set('X-API-Key', 'workflow-key');
  assert.equal((await pending()).body[0].id, j.id);
  assert.equal(runPdfBereinigungJob(s.db, s.config).archiviert, 0);
  assert.ok(existsSync(j.path));
  const manifest = (await s.get(j.id)).body;
  assert.equal((await s.post(j.id, s.receipt(manifest))).status, 200);
  assert.deepEqual((await pending()).body, []);
});

test('timestamp requirement cannot be bypassed by disabling TSA or by archive confirmation', async (t) => {
  const s = setup(t);
  const j = s.job();
  const manifest = (await s.get(j.id)).body;
  s.db.prepare('UPDATE jobs SET zeitstempel_erforderlich = 1 WHERE id = ?').run(j.id);
  setConfigValue(s.db, 'zeitstempel_tsa_url', '');
  assert.equal((await s.get(j.id)).status, 409);
  assert.equal((await s.post(j.id, s.receipt(manifest))).status, 409);
  assert.equal((await request(s.app).get(manifest.download_pfad).set('X-API-Key', 'workflow-key')).status, 409);
  assert.ok(existsSync(j.path));
});

test('modified bytes block manifest retrieval, receipt and later cleanup', async (t) => {
  const s = setup(t);
  const j = s.job();
  const original = readFileSync(j.path);
  const manifest = (await s.get(j.id)).body;
  writeFileSync(j.path, 'tampered');
  assert.equal((await s.get(j.id)).status, 409);
  assert.equal((await s.post(j.id, s.receipt(manifest))).status, 409);
  writeFileSync(j.path, original);
  const accepted = await s.post(j.id, s.receipt(manifest));
  assert.equal(accepted.status, 200);
  writeFileSync(j.path, 'tampered after receipt');
  t.mock.method(Date, 'now', () => Date.parse(accepted.body.quittung.bestaetigt_am) + ARCHIVE_RETENTION_MS);
  assert.equal(runPdfBereinigungJob(s.db, s.config).archiviert, 0);
  assert.ok(existsSync(j.path));
});

test('receipt insert failure rolls back pickup state and audit together', async (t) => {
  const s = setup(t);
  const j = s.job();
  const manifest = (await s.get(j.id)).body;
  const before = s.db.prepare('SELECT count(*) AS n FROM audit_ereignisse').get().n;
  s.db.exec("CREATE TRIGGER reject_receipt BEFORE INSERT ON archiv_quittungen BEGIN SELECT RAISE(ABORT, 'simulated disk failure'); END;");
  assert.equal((await s.post(j.id, s.receipt(manifest))).status, 500);
  assert.equal(getJobById(s.db, j.id).status, 'abgeschlossen');
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM audit_ereignisse').get().n, before);
  assert.ok(existsSync(j.path));
});

test('one Paperless document cannot confirm two different exports', async (t) => {
  const s = setup(t);
  const a = s.job('a');
  const b = s.job('b');
  const ma = (await s.get(a.id)).body;
  const mb = (await s.get(b.id)).body;
  assert.equal((await s.post(a.id, s.receipt(ma))).status, 200);
  assert.equal((await s.post(b.id, s.receipt(mb))).status, 409);
  assert.equal(getJobById(s.db, b.id).status, 'abgeschlossen');
});

test('splitgroup receipt binds the merged PDF, retains children and cleans up after retention', async (t) => {
  const s = setup(t);
  const parent = s.job('parent');
  const child = s.job('child', parent.id);
  const groupPath = join(s.dir, 'group.pdf');
  writeFileSync(groupPath, '%PDF group document');
  s.db.prepare("UPDATE jobs SET status = 'aufgesplittet', gruppe_pdf_pfad = ? WHERE id = ?").run(groupPath, parent.id);
  assert.equal((await s.get(child.id)).status, 409);
  const manifest = (await s.get(parent.id)).body;
  assert.equal(manifest.sha256, createHash('sha256').update(readFileSync(groupPath)).digest('hex'));
  assert.notEqual(manifest.sha256, parent.hash);
  assert.equal(manifest.positionen.length, 1);
  const res = await s.post(parent.id, s.receipt(manifest));
  assert.equal(res.status, 200);
  assert.equal(getJobById(s.db, child.id).status, 'abgeholt');
  assert.ok(existsSync(child.path));
  assert.ok(existsSync(groupPath));
  t.mock.method(Date, 'now', () => Date.parse(res.body.quittung.bestaetigt_am) + ARCHIVE_RETENTION_MS);
  assert.equal(runPdfBereinigungJob(s.db, s.config).archiviert, 1);
  assert.equal(existsSync(child.path), false);
  assert.equal(existsSync(groupPath), false);
  assert.equal((await s.post(parent.id, s.receipt(manifest))).status, 200);
  const gone = await request(s.app).get(manifest.download_pfad).set('X-API-Key', 'workflow-key');
  assert.equal(gone.status, 409, 'export download must never fall back to the original invoice');
});

test('simultaneous duplicate receipts create only one receipt and one audited insert', async (t) => {
  const s = setup(t);
  const j = s.job();
  const manifest = (await s.get(j.id)).body;
  const body = s.receipt(manifest);
  const [a, b] = await Promise.all([s.post(j.id, body), s.post(j.id, body)]);
  assert.equal(a.status, 200);
  assert.deepEqual(a.body, b.body);
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM archiv_quittungen').get().n, 1);
  assert.equal(s.db.prepare("SELECT count(*) AS n FROM audit_ereignisse WHERE objekt = 'archiv_quittungen' AND aktion = 'INSERT'").get().n, 1);
});

test('a group failure rolls back all children and the parent pickup marker', async (t) => {
  const s = setup(t);
  const parent = s.job('parent');
  const a = s.job('a', parent.id);
  const b = s.job('b', parent.id);
  s.db.prepare("UPDATE jobs SET status = 'aufgesplittet', gruppe_pdf_pfad = ? WHERE id = ?").run(parent.path, parent.id);
  const manifest = (await s.get(parent.id)).body;
  s.db.exec(`CREATE TRIGGER reject_child BEFORE UPDATE ON jobs
    WHEN NEW.id = ${b.id} AND NEW.status = 'abgeholt'
    BEGIN SELECT RAISE(ABORT, 'simulated child failure'); END;`);
  assert.equal((await s.post(parent.id, s.receipt(manifest))).status, 500);
  assert.equal(getJobById(s.db, a.id).status, 'abgeschlossen');
  assert.equal(getJobById(s.db, b.id).status, 'abgeschlossen');
  assert.equal(getJobById(s.db, parent.id).gruppe_abgeholt_am, null);
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM archiv_quittungen').get().n, 0);
});

test('unknown-hash legacy child files are retained even after a mature group receipt', async (t) => {
  const s = setup(t);
  const parent = s.job('parent');
  const child = s.job('legacy-child', parent.id);
  s.db.prepare('UPDATE jobs SET final_datei_hash = NULL WHERE id = ?').run(child.id);
  s.db.prepare("UPDATE jobs SET status = 'aufgesplittet', gruppe_pdf_pfad = ? WHERE id = ?").run(parent.path, parent.id);
  const manifest = (await s.get(parent.id)).body;
  const response = await s.post(parent.id, s.receipt(manifest));
  assert.equal(response.status, 200);
  // A later hash backfill must not retrospectively expand the receipt's coverage.
  s.db.prepare('UPDATE jobs SET final_datei_hash = ? WHERE id = ?').run(child.hash, child.id);
  t.mock.method(Date, 'now', () => Date.parse(response.body.quittung.bestaetigt_am) + ARCHIVE_RETENTION_MS);
  assert.equal(runPdfBereinigungJob(s.db, s.config).archiviert, 0);
  assert.ok(existsSync(child.path));
});

test('manifest uses approved metadata and remains unchanged after live data changes', async (t) => {
  const s = setup(t);
  const j = s.job();
  const snapshot = { job: { ...getJobById(s.db, j.id), betrag: '100.00', qr_iban: 'approved-iban' }, konto: { kontonummer: '3000' } };
  s.db.prepare('UPDATE jobs SET freigabe_snapshot = ?, betrag = ?, qr_iban = ? WHERE id = ?')
    .run(JSON.stringify(snapshot), '999.00', 'changed-iban', j.id);
  const manifest = (await s.get(j.id)).body;
  assert.equal(manifest.metadaten.betrag, '100.00');
  assert.equal(manifest.metadaten.qr_iban, 'approved-iban');
  assert.equal(manifest.metadaten.konto_kontonummer, '3000');
  s.db.prepare('UPDATE jobs SET betrag = ? WHERE id = ?').run('2000.00', j.id);
  assert.deepEqual((await s.get(j.id)).body, manifest);
});

test('a mature group receipt does not cover children added after export issuance', async (t) => {
  const s = setup(t);
  const parent = s.job('parent');
  s.job('original-child', parent.id);
  s.db.prepare("UPDATE jobs SET status = 'aufgesplittet', gruppe_pdf_pfad = ? WHERE id = ?").run(parent.path, parent.id);
  const manifest = (await s.get(parent.id)).body;
  const res = await s.post(parent.id, s.receipt(manifest));
  assert.equal(res.status, 200);
  const added = s.job('late-child', parent.id);
  s.db.prepare("UPDATE jobs SET status = 'abgeholt' WHERE id = ?").run(added.id);
  t.mock.method(Date, 'now', () => Date.parse(res.body.quittung.bestaetigt_am) + ARCHIVE_RETENTION_MS);
  runPdfBereinigungJob(s.db, s.config);
  assert.ok(existsSync(added.path));
  assert.equal(getJobById(s.db, added.id).status, 'abgeholt');
});
