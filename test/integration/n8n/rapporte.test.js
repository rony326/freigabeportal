import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../../src/db/index.js';
import { upsertPerson } from '../../../src/db/personenRepo.js';
import { seedDefaults, setConfigValue } from '../../../src/db/adminConfigRepo.js';
import { createJob, claimJob, getJobById } from '../../../src/db/jobsRepo.js';
import { requireApiKey } from '../../../src/middleware/apiKey.js';
import { createN8nRapporteRouter } from '../../../src/routes/n8n/rapporte.js';
import { createN8nJobsRouter } from '../../../src/routes/n8n/jobs.js';
import { markiereRapport, bestaetigeRapport } from '../../../src/services/rapporte.js';
import { buildPdfFixture } from '../../helpers/pdfFixture.js';
import { setupMockTsa, signedTsaResponse } from '../../helpers/mockTsa.js';
import { setzeFreigabeSnapshot } from '../../helpers/freigabeSnapshot.js';

const KEY = 'n8n-key';
const B = (id, vorname, nachname, gruppen = []) => ({ id, vorname, nachname, email: `${id}@example.org`, gruppen });

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'n8n-rapporte-'));
  const db = openDatabase(':memory:');
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  seedDefaults(db);
  setConfigValue(db, 'modul_rapporte_aktiv', '1');
  setConfigValue(db, 'zeitstempel_tsa_url', '');
  for (const p of [B('1', 'Buch', 'Haltung', ['10']), B('2', 'Anna', 'Empfang')]) upsertPerson(db, p);
  const config = {
    churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20', groupIdManager: '30' },
    downloadSigningSecret: 's', publicBaseUrl: 'https://portal.example.org', tsaTrustRequired: false,
    jobsDir: dir, n8nApiKey: KEY,
  };
  const app = express();
  app.use('/api/n8n/rapporte', requireApiKey(config), createN8nRapporteRouter({ db, config }));
  app.use('/api/n8n/jobs', requireApiKey(config), createN8nJobsRouter({ db, config }));
  const mailer = { async sendMail() {} };
  let nr = 0;

  async function neuerJob(name) {
    const pdfPfad = join(dir, `${name}-${++nr}.pdf`);
    writeFileSync(pdfPfad, await buildPdfFixture([`${name} Seite 1`]));
    return createJob(db, { eingangAm: '2026-11-01T00:00:00.000Z', quelle: 'scanner', absender: 'absender@example.org', dateiname: `${name}.pdf`, pdfPfad });
  }
  async function rapport({ abschliessen = true } = {}) {
    const jobId = await neuerJob('rapport');
    claimJob(db, jobId, '1');
    const markierer = { churchtools_person_id: '1', vorname: 'Buch', nachname: 'Haltung' };
    const ergebnis = await markiereRapport(db, config, mailer, { job: getJobById(db, jobId), person: markierer, empfaengerIds: ['2'], bemerkung: 'Bitte lesen', ip: '' });
    assert.equal(ergebnis.ok, true);
    if (abschliessen) {
      const bestaetigt = await bestaetigeRapport(db, config, { jobId, person: { churchtools_person_id: '2', vorname: 'Anna', nachname: 'Empfang' }, ip: '' });
      assert.equal(bestaetigt.abgeschlossen, true);
      assert.equal(getJobById(db, jobId).status, 'abgeschlossen');
    }
    return jobId;
  }
  async function rechnung() {
    const jobId = await neuerJob('rechnung');
    const job = getJobById(db, jobId);
    const hash = createHash('sha256').update(readFileSync(job.pdf_pfad)).digest('hex');
    db.prepare("UPDATE jobs SET status = 'abgeschlossen', final_datei_hash = ? WHERE id = ?").run(hash, jobId);
    setzeFreigabeSnapshot(db, jobId);
    return jobId;
  }
  const get = (pfad) => request(app).get(pfad).set('X-API-Key', KEY);
  const post = (pfad, body) => request(app).post(pfad).set('X-API-Key', KEY).send(body);
  return { db, dir, config, app, rapport, rechnung, get, post };
}

const quittung = (manifest, dokument_id = 77) => ({ export_id: manifest.export_id, sha256: manifest.sha256, dokument_id, task_id: 'b2ba769c-455f-4d97-9fb6-986eac19a334' });

test('ohne X-API-Key → 401', async (t) => {
  const s = setup(t);
  const id = await s.rapport();
  assert.equal((await request(s.app).get('/api/n8n/rapporte/abholbereit')).status, 401);
  assert.equal((await request(s.app).get('/api/n8n/rapporte/archivierung-ausstehend')).status, 401);
  assert.equal((await request(s.app).get(`/api/n8n/rapporte/${id}/exportnachweis`)).status, 401);
  assert.equal((await request(s.app).post(`/api/n8n/rapporte/${id}/archivierung-bestaetigen`).send({})).status, 401);
});

test('abholbereit listet abgeschlossenen Rapport, nicht offenen und keine Rechnung', async (t) => {
  const s = setup(t);
  const fertig = await s.rapport();
  await s.rapport({ abschliessen: false });
  await s.rechnung();
  const res = await s.get('/api/n8n/rapporte/abholbereit');
  assert.equal(res.status, 200);
  const job = getJobById(s.db, fertig);
  assert.deepEqual(res.body, [{
    id: fertig, art: 'rapport', eingang_am: job.eingang_am, dateiname: 'rapport.pdf',
    abgeschlossen_am: job.abgeschlossen_am, export_nachweis_url: `/api/n8n/rapporte/${fertig}/exportnachweis`,
  }]);
});

test('abholbereit mit TSA aktiv: Rapport ohne Zeitstempel fehlt', async (t) => {
  const s = setup(t);
  const ohne = await s.rapport();
  setConfigValue(s.db, 'zeitstempel_tsa_url', 'https://tsa.example.org/tsr');
  const client = setupMockTsa('https://tsa.example.org/tsr');
  client.intercept({ path: '/tsr', method: 'POST' }).reply(200, signedTsaResponse, { headers: { 'content-type': 'application/timestamp-reply' } });
  const mit = await s.rapport();
  assert.ok(getJobById(s.db, mit).zeitstempel_gesetzt_am);
  const res = await s.get('/api/n8n/rapporte/abholbereit');
  assert.deepEqual(res.body.map((r) => r.id), [mit]);
  assert.equal((await s.get(`/api/n8n/rapporte/${ohne}/exportnachweis`)).status, 409);
});

test('exportnachweis: version 2, sha256 = Hash der final-PDF, metadaten.art = "rapport", zahlung null, download_pfad unter /api/n8n/rapporte', async (t) => {
  const s = setup(t);
  const id = await s.rapport();
  const job = getJobById(s.db, id);
  const res = await s.get(`/api/n8n/rapporte/${id}/exportnachweis`);
  assert.equal(res.status, 200);
  const m = res.body;
  assert.equal(m.version, 2);
  assert.equal(m.job_id, id);
  assert.equal(m.sha256, createHash('sha256').update(readFileSync(job.pdf_pfad)).digest('hex'));
  assert.equal(m.sha256, job.final_datei_hash);
  assert.equal(m.nachweis_status, 'kenntnisnahme');
  assert.equal(m.zahlung, null);
  assert.deepEqual(m.positionen, []);
  assert.equal(m.download_pfad, `/api/n8n/rapporte/${id}/exportdatei/${m.export_id}`);
  assert.equal(m.metadaten.art, 'rapport');
  assert.equal(m.metadaten.job_id, id);
  assert.equal(m.metadaten.datei_sha256, m.sha256);
  assert.equal(m.metadaten.dateiname, 'rapport.pdf');
  assert.equal(m.metadaten.bemerkung, 'Bitte lesen');
  assert.equal(m.metadaten.markiert_am, job.rapport_markiert_am);
  assert.equal(m.metadaten.abgeschlossen_am, job.abgeschlossen_am);
  assert.equal(m.metadaten.kenntnisnahmen.length, 1);
  assert.equal(m.metadaten.kenntnisnahmen[0].person_id, '2');
  assert.equal(m.metadaten.kenntnisnahmen[0].name, 'Anna Empfang');
  assert.ok(m.metadaten.kenntnisnahmen[0].bestaetigt_am);
  assert.deepEqual((await s.get(`/api/n8n/rapporte/${id}/exportnachweis`)).body, m, 'Manifest ist festgeschrieben');
});

test('exportdatei liefert exakt die Bytes; archivierung-bestaetigen → archiv_bestaetigt, status abgeholt', async (t) => {
  const s = setup(t);
  const id = await s.rapport();
  const m = (await s.get(`/api/n8n/rapporte/${id}/exportnachweis`)).body;
  const datei = await s.get(m.download_pfad).buffer(true).parse((res, cb) => { const teile = []; res.on('data', (c) => teile.push(c)); res.on('end', () => cb(null, Buffer.concat(teile))); });
  assert.equal(datei.status, 200);
  assert.match(datei.headers['content-type'], /application\/pdf/);
  assert.ok(Buffer.compare(datei.body, readFileSync(getJobById(s.db, id).pdf_pfad)) === 0);

  assert.deepEqual((await s.get('/api/n8n/rapporte/archivierung-ausstehend')).body, []);
  const res = await s.post(`/api/n8n/rapporte/${id}/archivierung-bestaetigen`, quittung(m));
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'archiv_bestaetigt');
  assert.equal(getJobById(s.db, id).status, 'abgeholt');
  // idempotent
  assert.equal((await s.post(`/api/n8n/rapporte/${id}/archivierung-bestaetigen`, quittung(m))).status, 200);
  assert.deepEqual((await s.get('/api/n8n/rapporte/abholbereit')).body, []);
  assert.deepEqual((await s.get('/api/n8n/rapporte/archivierung-ausstehend')).body, []);
});

test('archivierung-ausstehend listet abgeholten Rapport ohne Quittung, keine Rechnung', async (t) => {
  const s = setup(t);
  const id = await s.rapport();
  const rechnungId = await s.rechnung();
  s.db.prepare("UPDATE jobs SET status = 'abgeholt' WHERE id IN (?, ?)").run(id, rechnungId);
  assert.deepEqual((await s.get('/api/n8n/rapporte/archivierung-ausstehend')).body,
    [{ id, status: 'abgeholt', export_nachweis_url: `/api/n8n/rapporte/${id}/exportnachweis` }]);
});

test('Rechnungs-ID auf /api/n8n/rapporte/:id/exportnachweis → 404', async (t) => {
  const s = setup(t);
  const id = await s.rechnung();
  const res = await s.get(`/api/n8n/rapporte/${id}/exportnachweis`);
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'Job nicht gefunden.');
  // Auch eine bereits über /api/n8n/jobs erzeugte Rechnungs-Exportversion bleibt hier unerreichbar.
  const m = (await s.get(`/api/n8n/jobs/${id}/exportnachweis`)).body;
  assert.equal((await s.get(`/api/n8n/rapporte/${id}/exportdatei/${m.export_id}`)).status, 404);
  assert.equal((await s.post(`/api/n8n/rapporte/${id}/archivierung-bestaetigen`, quittung(m))).status, 404);
  assert.equal(getJobById(s.db, id).status, 'abgeschlossen');
  assert.equal((await s.get('/api/n8n/rapporte/abc/exportnachweis')).status, 400);
});
