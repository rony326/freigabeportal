import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { seedDefaults, setConfigValue } from '../../src/db/adminConfigRepo.js';
import { createKonto } from '../../src/db/kontenRepo.js';
import { createKreditkarte } from '../../src/db/kreditkartenRepo.js';
import { createKkBeleg, getKkBelegById, verwerfeKkBeleg } from '../../src/db/kkBelegeRepo.js';
import { createJob, getJobById, markiereJobAlsKkAbrechnung, listSplitKinder } from '../../src/db/jobsRepo.js';
import { loadCurrentPerson, requireLogin } from '../../src/middleware/roles.js';
import { loadNavFlags } from '../../src/middleware/nav.js';
import { createKkAbgleichRouter } from '../../src/routes/kkAbgleich.js';
import { createKontierungRouter } from '../../src/routes/kontierung.js';
import { buildPdfFixture } from '../helpers/pdfFixture.js';

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'kk-abgleich-'));
  const config = { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20' }, downloadSigningSecret: 's', jobsDir: dir, publicBaseUrl: 'https://portal.example.org' };
  const db = openDatabase(':memory:');
  seedDefaults(db);
  setConfigValue(db, 'modul_kreditkarten_aktiv', '1');
  for (const id of ['1', '2', '3', '4', '5', '6', '7']) upsertPerson(db, { id, vorname: `P${id}`, nachname: 'M', email: `p${id}@example.org`, gruppen: [] });
  // Person 1 = verantwortlich + Freigeber1 von "Eigen"; Person 5 = Freigeber1 von "Fremd".
  const eigen = createKonto(db, { kontonummer: '1000', bezeichnung: 'Eigen', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  const fremd = createKonto(db, { kontonummer: '2000', bezeichnung: 'Fremd', freigeber1Id: '5', stellvertreter1Id: '2', freigeber2Id: '6', stellvertreter2Id: '4' });
  const karteId = createKreditkarte(db, { bezeichnung: 'Visa Jugend', verantwortlichId: '1', erfassungOffen: true });
  const abrechnungPfad = join(dir, 'abrechnung.pdf');
  writeFileSync(abrechnungPfad, await buildPdfFixture(['Abrechnung September']));
  const jobId = createJob(db, { eingangAm: '2026-09-27T00:00:00.000Z', quelle: 'scanner', absender: 'karten@bank.example', dateiname: 'abrechnung.pdf', pdfPfad: abrechnungPfad });
  markiereJobAlsKkAbrechnung(db, jobId, { kreditkarteId: karteId, verantwortlichId: '1', ausStatus: 'unzugewiesen' });
  async function beleg(betrag, beschreibung, kontoId = null) {
    const pfad = join(dir, `beleg-${Math.random().toString(36).slice(2)}.pdf`);
    writeFileSync(pfad, await buildPdfFixture([`Beleg ${beschreibung}`]));
    return createKkBeleg(db, { kreditkarteId: karteId, hochgeladenVon: '7', gekauftVon: '7', quelle: 'web', pdfPfad: pfad, betrag, kaufdatum: '2026-09-03', beschreibung, kontoId, status: 'offen' });
  }
  const sent = [];
  const mailer = { async sendMail(m) { sent.push(m); } };
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', new URL('../../views', import.meta.url).pathname);
  app.use((req, res, next) => { res.locals.branding = { primaryColor: '#000', secondaryColor: '#fff', hasLogo: false, themeAttr: null }; next(); });
  app.use(express.urlencoded({ extended: false }));
  app.use((req, res, next) => { req.session = { personId: req.headers['x-test-person-id'] }; next(); });
  app.use(loadCurrentPerson(db));
  app.use(loadNavFlags(db, config));
  app.use('/kontierung', requireLogin(), createKkAbgleichRouter({ db, config, mailer }));
  app.use('/kontierung', requireLogin(), createKontierungRouter({ db, config, mailer }));
  return { db, app, dir, config, eigen, fremd, karteId, jobId, beleg, sent, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('GET /kontierung/:id/kk-abgleich shows the open receipts of the card to the assigned person only', async () => {
  const t = await setup();
  await t.beleg('12.50', 'Zugticket');
  const ok = await request(t.app).get(`/kontierung/${t.jobId}/kk-abgleich`).set('x-test-person-id', '1');
  assert.equal(ok.status, 200);
  assert.match(ok.text, /Zugticket/);
  assert.match(ok.text, /Visa Jugend/);
  const fremd = await request(t.app).get(`/kontierung/${t.jobId}/kk-abgleich`).set('x-test-person-id', '5');
  assert.equal(fremd.status, 403);
  t.cleanup();
});

test('GET /kontierung/:id/kk-abgleich on an unmarked job is 409', async () => {
  const t = await setup();
  const id = createJob(t.db, { eingangAm: '2026-09-27T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'x.pdf', pdfPfad: join(t.dir, 'abrechnung.pdf') });
  t.db.prepare("UPDATE jobs SET status = 'zugewiesen', zugewiesen_an = '1' WHERE id = ?").run(id);
  assert.equal((await request(t.app).get(`/kontierung/${id}/kk-abgleich`).set('x-test-person-id', '1')).status, 409);
  t.cleanup();
});

test('GET /kontierung/:id/kk-abgleich still works with the module switched off', async () => {
  const t = await setup();
  setConfigValue(t.db, 'modul_kreditkarten_aktiv', '0');
  assert.equal((await request(t.app).get(`/kontierung/${t.jobId}/kk-abgleich`).set('x-test-person-id', '1')).status, 200);
  t.cleanup();
});
