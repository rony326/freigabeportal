import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/db/index.js';
import { setConfigValue } from '../../src/db/adminConfigRepo.js';
import { createJob, getJobById } from '../../src/db/jobsRepo.js';
import { listRecentCronLog, startCronLauf } from '../../src/db/cronLogRepo.js';
import { runZeitstempelNachholenJob } from '../../src/services/cronJobs.js';
import { setupMockTsa } from '../helpers/mockTsa.js';
import { buildPdfFixture } from '../helpers/pdfFixture.js';

const RFC3161_RESPONSE = readFileSync(new URL('../fixtures/rfc3161-response.der', import.meta.url));

async function seedAbgeschlossenJob(db, dir, { zeitstempelGesetzt = false } = {}) {
  const pdfPfad = join(dir, `job-${Math.random().toString(36).slice(2)}.pdf`);
  writeFileSync(pdfPfad, await buildPdfFixture(['Rechnung Seite 1']));
  const id = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad });
  db.prepare("UPDATE jobs SET status = 'abgeschlossen' WHERE id = ?").run(id);
  if (zeitstempelGesetzt) {
    db.prepare("UPDATE jobs SET zeitstempel_gesetzt_am = '2026-08-01T00:00:00.000Z' WHERE id = ?").run(id);
  }
  return { id, pdfPfad };
}

test('runZeitstempelNachholenJob returns uebersprungen and writes no cron_log entry when no TSA URL is configured', async () => {
  const db = openDatabase(':memory:');
  const result = await runZeitstempelNachholenJob(db);
  assert.equal(result.status, 'uebersprungen');
  assert.equal(listRecentCronLog(db, 'zeitstempel-nachholen', 10).length, 0);
  db.close();
});

test('runZeitstempelNachholenJob sets zeitstempel_gesetzt_am for a pending abgeschlossen job and logs the run', async () => {
  const db = openDatabase(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'nachholen-test-'));
  setConfigValue(db, 'zeitstempel_tsa_url', 'https://tsa.example.org/tsr');
  const { id } = await seedAbgeschlossenJob(db, dir);

  const client = setupMockTsa('https://tsa.example.org/tsr');
  client.intercept({ path: '/tsr', method: 'POST' }).reply(200, RFC3161_RESPONSE, { headers: { 'content-type': 'application/timestamp-reply' } });

  const result = await runZeitstempelNachholenJob(db, {});
  assert.equal(result.status, 'erfolg');
  assert.equal(result.nachgeholt, 1);
  assert.equal(result.fehlgeschlagen, 0);
  assert.equal(result.dateiFehlt, 0);
  assert.ok(getJobById(db, id).zeitstempel_gesetzt_am);

  const log = listRecentCronLog(db, 'zeitstempel-nachholen', 1);
  assert.equal(log.length, 1);
  assert.equal(log[0].status, 'erfolg');
  assert.match(log[0].details, /Nachgeholt: 1/);

  rmSync(dir, { recursive: true, force: true });
  db.close();
});

test('runZeitstempelNachholenJob skips a job that already has a timestamp, without contacting the TSA for it', async () => {
  const db = openDatabase(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'nachholen-test-'));
  setConfigValue(db, 'zeitstempel_tsa_url', 'https://tsa.example.org/tsr');
  await seedAbgeschlossenJob(db, dir, { zeitstempelGesetzt: true });
  const { id: pendingId } = await seedAbgeschlossenJob(db, dir);

  // A single, non-persistent interceptor: if the already-timestamped job were also (wrongly)
  // retried, the second TSA request would find no matching interceptor left and fail, which
  // would surface as fehlgeschlagen > 0 below.
  const client = setupMockTsa('https://tsa.example.org/tsr');
  client.intercept({ path: '/tsr', method: 'POST' }).reply(200, RFC3161_RESPONSE, { headers: { 'content-type': 'application/timestamp-reply' } });

  const result = await runZeitstempelNachholenJob(db, {});
  assert.equal(result.nachgeholt, 1);
  assert.equal(result.fehlgeschlagen, 0);
  assert.ok(getJobById(db, pendingId).zeitstempel_gesetzt_am);

  rmSync(dir, { recursive: true, force: true });
  db.close();
});

test('runZeitstempelNachholenJob counts a job whose PDF file no longer exists as dateiFehlt, without erroring', async () => {
  const db = openDatabase(':memory:');
  setConfigValue(db, 'zeitstempel_tsa_url', 'https://tsa.example.org/tsr');
  const id = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/nonexistent/gone.pdf' });
  db.prepare("UPDATE jobs SET status = 'abgeschlossen' WHERE id = ?").run(id);

  const result = await runZeitstempelNachholenJob(db, {});
  assert.equal(result.status, 'erfolg');
  assert.equal(result.nachgeholt, 0);
  assert.equal(result.dateiFehlt, 1);
  assert.equal(getJobById(db, id).zeitstempel_gesetzt_am, null);

  db.close();
});

test('runZeitstempelNachholenJob skips (uebersprungen) when another zeitstempel-nachholen run is already laufend, without touching pending jobs', async () => {
  const db = openDatabase(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'nachholen-test-'));
  setConfigValue(db, 'zeitstempel_tsa_url', 'https://tsa.example.org/tsr');
  const { id } = await seedAbgeschlossenJob(db, dir);

  // No interceptor registered -- if the guard failed to skip and the job proceeded anyway, the
  // TSA call would find nothing to respond and the job would come back fehlgeschlagen instead of
  // untouched, exposing the bug just as clearly as a hang would.
  setupMockTsa('https://tsa.example.org/tsr');
  // Simulate a scheduled run still mid-batch (Task 5's manual trigger would call this same
  // function while that scheduled run's cron_log row is still 'laufend').
  startCronLauf(db, 'zeitstempel-nachholen');

  const result = await runZeitstempelNachholenJob(db, {});
  assert.equal(result.status, 'uebersprungen');
  assert.equal(result.nachgeholt, 0);
  assert.equal(getJobById(db, id).zeitstempel_gesetzt_am, null, 'the pending job must not have been touched while another run is active');

  rmSync(dir, { recursive: true, force: true });
  db.close();
});

test('runZeitstempelNachholenJob counts a TSA failure as fehlgeschlagen without aborting the whole run', async () => {
  const db = openDatabase(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'nachholen-test-'));
  setConfigValue(db, 'zeitstempel_tsa_url', 'https://tsa.example.org/tsr');
  const { id } = await seedAbgeschlossenJob(db, dir);
  setupMockTsa('https://tsa.example.org/tsr'); // no .intercept() registered -> unreachable

  const result = await runZeitstempelNachholenJob(db, {});
  assert.equal(result.status, 'erfolg', 'a per-job TSA failure must not turn the whole run into a fehler status');
  assert.equal(result.nachgeholt, 0);
  assert.equal(result.fehlgeschlagen, 1);
  assert.equal(getJobById(db, id).zeitstempel_gesetzt_am, null);

  rmSync(dir, { recursive: true, force: true });
  db.close();
});
