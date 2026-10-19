import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createKonto } from '../../src/db/kontenRepo.js';
import { createJob, getJobById } from '../../src/db/jobsRepo.js';
import { createFreigabe } from '../../src/db/freigabenRepo.js';
import { seedDefaults } from '../../src/db/adminConfigRepo.js';
import { loadCurrentPerson, requireLogin } from '../../src/middleware/roles.js';
import { loadNavFlags } from '../../src/middleware/nav.js';
import { createFreigabe2Router } from '../../src/routes/freigabe2.js';

function buildApp(db) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', new URL('../../views', import.meta.url).pathname);
  app.use((req, res, next) => {
    res.locals.branding = { primaryColor: '#000', secondaryColor: '#fff', hasLogo: false, themeAttr: null };
    next();
  });
  app.use(express.urlencoded({ extended: false }));
  app.use((req, res, next) => {
    req.session = { personId: req.headers['x-test-person-id'] };
    next();
  });
  const config = {
    tsaTrustRequired: false,
    churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20' },
    downloadSigningSecret: 'test-secret',
    publicBaseUrl: 'https://portal.example.org',
  };
  app.use(loadCurrentPerson(db));
  app.use(loadNavFlags(db, config));
  app.use('/freigabe2', requireLogin(), createFreigabe2Router({ db, config, mailer: { async sendMail() {} } }));
  return app;
}

function seed(db) {
  for (const id of ['1', '2', '3', '4', '5']) {
    upsertPerson(db, { id, vorname: `P${id}`, nachname: 'M', email: `p${id}@example.org`, gruppen: ['10'], loggedInNow: true });
  }
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'U', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  const jobId = createJob(db, { eingangAm: '2026-10-01T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  createFreigabe(db, { jobId, personId: '1', rolle: 'freigeber1', zeitpunkt: '2026-10-01T08:30:00.000Z', ip: '1.2.3.4', interessenskonflikt: false, kommentar: null, eskaliertVon: null });
  db.prepare("UPDATE jobs SET status = 'freigabe2', konto_id = ?, zugewiesen_an = '1', freigabe2_umgeleitet_an = '5' WHERE id = ?").run(kontoId, jobId);
  return jobId;
}

test('umgeleitete Person darf Freigabe 2 öffnen, der ursprüngliche Freigeber 2 nicht', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  const jobId = seed(db);
  const app = buildApp(db);
  assert.equal((await request(app).get(`/freigabe2/${jobId}`).set('x-test-person-id', '5')).status, 200);
  assert.equal((await request(app).get(`/freigabe2/${jobId}`).set('x-test-person-id', '3')).status, 403);
  db.close();
});

test('Interessenskonflikt der umgeleiteten Person geht direkt an die Admin-Gruppe und löscht die Umleitung', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  const jobId = seed(db);
  const app = buildApp(db);
  const res = await request(app)
    .post(`/freigabe2/${jobId}`)
    .set('x-test-person-id', '5')
    .type('form')
    .send({ aktion: 'freigeben', interessenskonflikt: 'ja', begruendung: 'Eigene Firma' });
  assert.equal(res.status, 302);
  const job = getJobById(db, jobId);
  assert.equal(job.freigabe2_eskaliert_an_admin, 1);
  assert.equal(job.freigabe2_umgeleitet_an, null);
  db.close();
});
