import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import net from 'node:net';
import request from 'supertest';
import { EventEmitter } from 'node:events';
import { exchangeCodeForToken, fetchPerson, fetchPersonById, fetchGroupMemberIds } from '../../src/services/churchtools.js';
import { installeProzessWaechter } from '../../src/services/prozessWaechter.js';
import { openDatabase } from '../../src/db/index.js';
import { seedDefaults, setConfigValue } from '../../src/db/adminConfigRepo.js';
import { createApp } from '../../src/app.js';
import { createHash } from 'node:crypto';

// Task 4 / Verfügbarkeit und Betrieb: lokale Absturz- und Ausfallpfade. Der Prozess darf durch
// keine einzelne (auch unauthentifizierte) Anfrage beendet werden, und ein echter Ausfall muss
// über /healthz als solcher sichtbar werden (Uptime-Kuma-Meldung).
// Siehe task-4-funde.md für die zugehörigen Fundzeilen.

function testConfig() {
  return {
    sessionSecret: 'test-secret-test-secret-test-secret',
    env: 'test',
    churchtools: {
      baseUrl: 'https://ct.example.org',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri: 'https://portal.example.org/auth/callback',
      groupIdBuchhaltung: '10',
      groupIdAdmin: '20',
      syncServiceToken: 'token',
    },
    cronSecret: 'cron-secret',
    smtp: { host: 'smtp.example.org', port: 587, user: 'user', pass: 'pass', from: 'portal@example.org' },
    publicBaseUrl: 'http://portal.example.org',
    downloadSigningSecret: 'download-secret',
  };
}

function frischeApp() {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  const app = createApp({ db, config: testConfig() });
  return { db, app };
}

// A4-03 (CVE-01, body-parser GHSA-27r3-jxmh-p828): express.json()/urlencoded() laufen global vor
// dem Routing. Eine Anfrage mit Content-Encoding: gzip, deren gültiger Rahmen von angehängten
// Bytes gefolgt wird, darf den Prozess nicht beenden. Dieser Test ist der von Task 1 vorgeschlagene
// Regressionswächter. In dieser Umgebung (Node 22.x, body-parser 1.20.8) liess sich der im
// Advisory beschriebene Prozess-Abbruch NICHT reproduzieren: der zlib-Fehler wird abgefangen und
// als HTTP-Antwort zurückgegeben (siehe A4-04 zur 500-statt-400-Klassifizierung). Der Test ist
// deshalb AKTIV und grün und bleibt es nach dem Patch auf 1.20.9. (Hinweis für Task 5: aktiv,
// nicht übersprungen.) Entscheidend ist der Liveness-Beweis am Ende: der Prozess steht noch.
test('A4-03: gzip-Body mit angehängten Bytes beendet den Prozess nicht', async () => {
  const { app } = frischeApp();
  const gueltig = zlib.gzipSync(Buffer.from('{"quelle":"scanner"}'));
  for (const trailer of [
    Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe]),
    Buffer.from([0x1f, 0x8b, 0x08, 0x00]),
    zlib.gzipSync(Buffer.from('{}')),
  ]) {
    const body = Buffer.concat([gueltig, trailer]);
    const res = await request(app)
      .post('/api/n8n/jobs')
      .set('Content-Type', 'application/json')
      .set('Content-Encoding', 'gzip')
      .send(body);
    // Der Server muss überhaupt antworten (kein Hängen, kein Absturz). Status 4xx oder 5xx — beides
    // heisst "der zentrale Fehler-Handler lief", nicht "der Prozess starb".
    assert.ok(res.status >= 400 && res.status < 600, `erwartet eine Antwort, war ${res.status}`);
  }
  // Der eigentliche Liveness-Beweis: nach den Angriffsanfragen wird eine normale Anfrage weiterhin
  // bedient. Wäre der Prozess beendet worden, liefe supertest hier gegen einen toten Server.
  const danach = await request(app).get('/auth/login');
  assert.equal(danach.status, 302);
});

// A4-04: Ein defekter komprimierter Body (Content-Encoding: gzip + Trailing-Bytes) erzeugt einen
// rohen zlib-Fehler ohne err.type. Er muss als 400 (Client-Fehler) beantwortet werden und darf
// NICHT pro Anfrage einen Stacktrace ins Log schreiben — sonst flutet ein unauthentifizierter
// Client das Log (Log-Flood, verstärkt O6).
test('A4-04: defekter gzip-Body ergibt 400 ohne Stack-Log', async () => {
  const { app } = frischeApp();
  const body = Buffer.concat([zlib.gzipSync(Buffer.from('{"quelle":"scanner"}')), Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe])]);
  const original = console.error;
  const logs = [];
  console.error = (...args) => { logs.push(args.map((a) => (a && a.stack) || String(a)).join(' ')); };
  let res;
  try {
    res = await request(app)
      .post('/api/n8n/jobs')
      .set('Content-Type', 'application/json')
      .set('Content-Encoding', 'gzip')
      .send(body);
  } finally {
    console.error = original;
  }
  assert.equal(res.status, 400, `erwartet 400, war ${res.status}`);
  const stackArtig = logs.filter((zeile) => /incorrect header check|Z_DATA_ERROR|\n\s+at /.test(zeile));
  assert.deepEqual(stackArtig, [], `kein Stacktrace ins Log erwartet, war: ${stackArtig.join(' | ')}`);
});

// A4-02: Prozess-Sicherheitsnetz. Eine unbehandelte Ausnahme UND eine unbehandelte
// Promise-Ablehnung müssen je eine Logzeile (ohne Geheimnisse) erzeugen und zum sauberen Exit(1)
// führen, damit der Plattform-Auto-Restart übernimmt. Re-entrancy: ein zweites Ereignis löst keinen
// zweiten Exit aus.
test('A4-02: Waechter loggt und beendet bei uncaughtException/unhandledRejection', () => {
  for (const ereignis of ['uncaughtException', 'unhandledRejection']) {
    const prozess = new EventEmitter();
    const logs = [];
    const exitCodes = [];
    installeProzessWaechter({ prozess, logger: { error: (...a) => logs.push(a.map(String).join(' ')) }, exit: (c) => exitCodes.push(c) });
    prozess.emit(ereignis, new Error('platzt'));
    assert.equal(exitCodes.length, 1, `erwartet genau ein Exit bei ${ereignis}`);
    assert.equal(exitCodes[0], 1);
    assert.equal(logs.length, 1, 'erwartet genau eine Logzeile');
    assert.match(logs[0], /platzt/);
    // Re-entrancy: ein weiteres Ereignis beendet nicht erneut.
    prozess.emit('uncaughtException', new Error('nochmal'));
    assert.equal(exitCodes.length, 1, 'kein zweiter Exit erwartet');
  }
});

// Step 1: ungültige Eingaben an Maschinen-Routen (hier: kaputter JSON-Body) müssen als 400 vom
// zentralen Fehler-Handler (entity.*-Zweig in app.js) behandelt werden, nicht als 500/Absturz.
test('A4: kaputter JSON-Body ergibt 400, kein Absturz', async () => {
  const { app } = frischeApp();
  const res = await request(app)
    .post('/api/n8n/jobs')
    .set('Content-Type', 'application/json')
    .send('{"quelle":');
  assert.ok(res.status === 400 || res.status === 401, `erwartet 400/401, war ${res.status}`);
  const danach = await request(app).get('/auth/login');
  assert.equal(danach.status, 302);
});

// Step 3/4 (O7): /healthz ohne Monitoring-Schlüssel muss einen echten Datenbankausfall als 503
// melden, damit Uptime Kuma ihn erkennt. Bei gesunder DB liefert es 200 {status:'ok'}.
test('A4: /healthz meldet einen Datenbankausfall als 503', async () => {
  const { db, app } = frischeApp();
  const gesund = await request(app).get('/healthz');
  assert.equal(gesund.status, 200);
  assert.equal(gesund.body.status, 'ok');

  // Harter Ausfall: Verbindung geschlossen -> jede Abfrage wirft -> pruefeDatenbank = 'fehler'.
  db.close();
  const krank = await request(app).get('/healthz');
  assert.equal(krank.status, 503);
  assert.equal(krank.body.status, 'fehler');
});

// Step 3/4 (O7): mit gültigem Monitoring-Schlüssel kommt der volle Dienststatus; eine gesunde
// Instanz ist 200, und der Schlüssel wird nur als SHA-256 verglichen (kein Klartext in der DB).
test('A4: /healthz mit Monitoring-Schlüssel liefert Dienststatus', async () => {
  const { db, app } = frischeApp();
  const key = 'uptime-kuma-schluessel';
  setConfigValue(db, 'monitoring_secret', createHash('sha256').update(key).digest('hex'));
  const res = await request(app).get('/healthz').set('x-monitoring-key', key);
  assert.equal(res.status, 200);
  assert.ok(res.body.dienste && res.body.dienste.datenbank, 'Dienststatus fehlt');
  const falsch = await request(app).get('/healthz').set('x-monitoring-key', 'falsch');
  // Falscher Schlüssel: keine Detailinfos, aber weiterhin die schlichte ok/fehler-Antwort.
  assert.equal(falsch.status, 200);
  assert.equal(falsch.body.dienste, undefined);
});

// A4-01 (ChurchTools ohne Timeout): exchangeCodeForToken/fetchPerson/fetchPersonById und der
// nächtliche Sync (fetchGroupMemberIds via resolveMemberGroupIds) rufen fetch() OHNE AbortSignal.
// Eine hängende ChurchTools-Instanz (TCP offen, keine Antwort) lässt die Login-Anfrage unbegrenzt
// hängen und blockiert den Sync dauerhaft (Reentrancy-Guard `laeuft` in scheduler.js wird nie
// zurückgesetzt). Übersprungen: der Nachweis würde die Verbindung real hängen lassen; Fix =
// AbortSignal.timeout an allen CT-fetch-Aufrufen (die Signal-Plumbing existiert bereits für
// fetchGroup/fetchGroupMemberIds). Siehe task-4-funde.md A4-01. (Hinweis für Task 5: übersprungen.)
// A4-01 (behoben): Eine hängende CT-Instanz (TCP offen, keine Antwort) darf weder die Login-Pfade
// (exchangeCodeForToken/fetchPerson) noch den Sync-Pfad (fetchPersonById/fetchGroupMemberIds)
// unbegrenzt blockieren. Nachweis mit einem echten TCP-Server, der die Verbindung annimmt und nie
// antwortet: jeder Aufruf muss per AbortSignal.timeout abbrechen (und nicht hängen). Das Zeitlimit
// ist über config.ctFetchTimeoutMs für den Test kurz gesetzt; produktiv gilt der 15-s-Standard.
test('A4-01: ChurchTools-fetch-Aufrufe brechen bei hängender Gegenstelle per Zeitlimit ab', async () => {
  // Server nimmt die Verbindung an, hält den Socket offen und antwortet nie.
  const haltendeSockets = [];
  const server = net.createServer((socket) => { haltendeSockets.push(socket); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const config = {
    baseUrl: `http://127.0.0.1:${port}`,
    clientId: 'c', clientSecret: 's', redirectUri: 'http://portal.example.org/auth/callback',
    ctFetchTimeoutMs: 200,
  };
  try {
    const istZeitlimit = (err) => err && (err.name === 'TimeoutError' || err.name === 'AbortError'
      || /aborted|timeout|zeit/i.test(String(err.cause?.name || err.cause?.message || err.message)));
    for (const aufruf of [
      () => exchangeCodeForToken(config, 'code'),
      () => fetchPerson(config, 'access-token'),
      () => fetchPersonById(config, 'login-token', 42),
      () => fetchGroupMemberIds(config, 'login-token', '1'),
    ]) {
      const start = Date.now();
      await assert.rejects(aufruf, istZeitlimit, 'Aufruf hätte per Zeitlimit abbrechen müssen');
      // Beweis, dass das Zeitlimit greift und der Aufruf nicht einfach hängt: deutlich unter 15 s.
      assert.ok(Date.now() - start < 5000, `Aufruf hing zu lange: ${Date.now() - start} ms`);
    }
  } finally {
    for (const socket of haltendeSockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});
