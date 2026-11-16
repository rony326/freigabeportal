// S3: Gesamtgrösse je Upload-Anfrage (60 MB) und Zuständigkeitsprüfung vor dem Upload.
// Die Tests arbeiten mit rohen HTTP-Anfragen gegen einen echten Port: nur so lässt sich beobachten, dass der Server
// antwortet und abbricht, ohne dass der Body vollständig angekommen ist.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createKonto } from '../../src/db/kontenRepo.js';
import { createJob, claimJob } from '../../src/db/jobsRepo.js';
import { seedDefaults } from '../../src/db/adminConfigRepo.js';
import { loadCurrentPerson, requireLogin } from '../../src/middleware/roles.js';
import { loadNavFlags } from '../../src/middleware/nav.js';
import { createKontierungRouter } from '../../src/routes/kontierung.js';
import { createSpesenRouter } from '../../src/routes/spesen.js';

const MB = 1024 * 1024;

async function startApp() {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  for (const id of ['1', '2', '3', '4', '5']) upsertPerson(db, { id, vorname: `P${id}`, nachname: 'M', email: `p${id}@example.org`, gruppen: [], loggedInNow: true });
  createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'lieferant', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, jobId, '1');
  const config = { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20' }, downloadSigningSecret: 's', publicBaseUrl: 'https://portal.example.org', jobsDir: '/tmp' };
  const mailer = { async sendMail() {} };
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', new URL('../../views', import.meta.url).pathname);
  app.use((req, res, next) => { res.locals.branding = { primaryColor: '#000', secondaryColor: '#fff', hasLogo: false, themeAttr: null }; next(); });
  app.use(express.urlencoded({ extended: false }));
  app.use((req, res, next) => { req.session = { personId: req.headers['x-test-person-id'] }; next(); });
  app.use(loadCurrentPerson(db));
  app.use(loadNavFlags(db, config));
  app.use('/kontierung', requireLogin(), createKontierungRouter({ db, config, mailer }));
  app.use('/spesen', requireLogin(), createSpesenRouter({ db, config, mailer }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { db, jobId, port: server.address().port, close: () => { server.closeAllConnections(); server.close(); db.close(); } };
}

// Schickt eine multipart-Anfrage und liefert {status, text} sobald der Server antwortet — auch wenn der Body noch nicht fertig ist.
// `kopf` = Header (Content-Length gesetzt oder nicht), `schreibe(req)` schreibt den Body. Wartet höchstens `timeoutMs` auf eine Antwort.
function sende(port, pfad, personId, kopf, schreibe, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pfad, method: 'POST', headers: { 'x-test-person-id': personId, 'content-type': 'multipart/form-data; boundary=xyz', ...kopf } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => { clearTimeout(timer); resolve({ status: res.statusCode, text }); });
    });
    const timer = setTimeout(() => { req.destroy(); reject(new Error(`keine Antwort innerhalb von ${timeoutMs} ms`)); }, timeoutMs);
    req.on('error', () => {}); // Der Server darf die Verbindung nach der Antwort kappen.
    schreibe(req);
  });
}

// Schreibt `anzahl` Dateiteile je `groesse` Bytes als Chunks, mit Rücksicht auf den Gegendruck.
async function schreibeDateien(req, anzahl, groesse, zaehler = { bytes: 0 }) {
  const block = Buffer.alloc(MB, 0x61);
  for (let i = 0; i < anzahl; i++) {
    if (req.destroyed) return;
    req.write(`--xyz\r\nContent-Disposition: form-data; name="posBeleg_${i}"; filename="b${i}.pdf"\r\nContent-Type: application/pdf\r\n\r\n`);
    for (let n = 0; n < groesse / MB; n++) {
      if (req.destroyed) return;
      zaehler.bytes += block.length;
      if (!req.write(block)) await new Promise((r) => req.once('drain', r));
    }
    req.write('\r\n');
  }
  if (!req.destroyed) req.end('--xyz--\r\n');
}

test('S3: eine Anfrage mit deklarierter Gesamtgrösse über 60 MB wird sofort mit 413 und verständlicher Meldung abgewiesen, ohne den Body abzuwarten', async () => {
  const t = await startApp();
  try {
    const res = await sende(t.port, '/spesen', '5', { 'content-length': String(70 * MB) }, (req) => req.write('--xyz\r\n'));
    assert.equal(res.status, 413);
    assert.match(res.text, /60 MB/);
  } finally { t.close(); }
});

test('S3: ohne Content-Length (chunked) wird nach 60 MB tatsächlich gelesener Bytes abgebrochen und mit 413 geantwortet', async () => {
  const t = await startApp();
  try {
    // 4 Dateien zu je 19 MB: jede für sich unter dem Einzellimit von 20 MB, zusammen 76 MB.
    const zaehler = { bytes: 0 };
    const res = await sende(t.port, '/spesen', '5', {}, (req) => { schreibeDateien(req, 4, 19 * MB, zaehler); }, 15000);
    assert.equal(res.status, 413);
    // Abgebrochen, nicht erst nach vollständigem Puffern: der Absender hat beim Eintreffen der Antwort noch nicht alles gesendet.
    assert.ok(zaehler.bytes < 76 * MB, `Absender hatte schon ${zaehler.bytes} Bytes gesendet`);
    assert.match(res.text, /60 MB/);
  } finally { t.close(); }
});

test('S3: ein Unzuständiger bekommt 403 auf /kontierung/:id, ohne dass der Upload abgewartet wird', async () => {
  const t = await startApp();
  try {
    // Deklarierte 50 MB (unter dem Gesamtlimit), aber nur ein paar Bytes gesendet: Antwort kommt nur, wenn vor multer geprüft wird.
    const res = await sende(t.port, `/kontierung/${t.jobId}`, '5', { 'content-length': String(50 * MB) }, (req) => req.write('--xyz\r\n'));
    assert.equal(res.status, 403);
    assert.match(res.text, /nicht zur Kontierung zugewiesen/);
  } finally { t.close(); }
});

test('S3: dasselbe gilt für /kontierung/:id/aufsplitten', async () => {
  const t = await startApp();
  try {
    const res = await sende(t.port, `/kontierung/${t.jobId}/aufsplitten`, '5', { 'content-length': String(50 * MB) }, (req) => req.write('--xyz\r\n'));
    assert.equal(res.status, 403);
  } finally { t.close(); }
});
