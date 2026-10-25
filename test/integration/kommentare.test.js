// Kommentarbereich auf den Rechnungsseiten (Task 2, docs/superpowers/specs/2026-10-25-kommentare-design.md).
// Echte createApp-Verdrahtung (CSRF, Mount-Pfade, Fehlerbehandlung); die Sitzung setzt eine äussere
// Mini-App (express-session übernimmt ein vorhandenes req.session).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/db/index.js';
import { seedDefaults } from '../../src/db/adminConfigRepo.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createKonto } from '../../src/db/kontenRepo.js';
import { createJob, claimJob, setKontierung, abschliessenFreigabe1, ablehnenJob, createSpesenPosition, markiereJobAlsKkAbrechnung } from '../../src/db/jobsRepo.js';
import { createKreditkarte } from '../../src/db/kreditkartenRepo.js';
import { setConfigValue } from '../../src/db/adminConfigRepo.js';
import { createSpesenabrechnung } from '../../src/db/spesenabrechnungenRepo.js';
import { createFreigabe } from '../../src/db/freigabenRepo.js';
import { setBerechtigungenForPerson } from '../../src/db/personBerechtigungenRepo.js';
import { createApp } from '../../src/app.js';
import { erstelleSpielwiese } from '../../src/services/testmodus/spielwiese.js';
import { createTestMailer } from '../../src/services/testmodus/testMailer.js';
import { warteBis } from '../helpers/warteBis.js';

const csrfAus = (text) => {
  const m = text.match(/name="_csrf" value="([^"]+)"/);
  if (!m) throw new Error('kein _csrf-Feld');
  return m[1];
};

function testConfig(dir) {
  return {
    sessionSecret: 'test-secret',
    env: 'test',
    // http: sonst setzt csrf-csrf ein Secure-Cookie, das supertest nicht zurückschickt.
    publicBaseUrl: 'http://portal.example.org',
    churchtools: {
      baseUrl: 'https://ct.example.org', clientId: 'client-id', clientSecret: 'client-secret',
      redirectUri: 'https://portal.example.org/auth/callback', groupIdBuchhaltung: '10', groupIdAdmin: '20', syncServiceToken: 'token',
    },
    cronSecret: 'cron-secret',
    n8nApiKey: 'n8n-key',
    smtp: { host: 'smtp.example.org', port: 587, user: 'user', pass: 'pass', from: 'portal@example.org' },
    brandingDir: dir, jobsDir: dir, backupDir: dir,
    downloadSigningSecret: 'download-secret',
  };
}

const PERSONEN = [
  ['1', 'Anna', 'Beispiel', ['10']],
  ['2', 'Bruno', 'Stell', []],
  ['3', 'Clara', 'Zwei', []],
  ['4', 'Dora', 'Vier', []],
  ['5', 'Emil', 'Fremd', []],
  ['6', 'Fritz', 'Admin', ['20']],
  ['7', 'Gina', 'Einsicht', []],
  ['9', 'Ida', 'Spesen', []],
];

function umgebung() {
  const dir = mkdtempSync(join(tmpdir(), 'kommentare-int-'));
  const config = testConfig(dir);
  const db = openDatabase(':memory:');
  seedDefaults(db);
  for (const [id, vorname, nachname, gruppen] of PERSONEN) {
    upsertPerson(db, { id, vorname, nachname, email: `p${id}@example.org`, gruppen, loggedInNow: true });
  }
  setBerechtigungenForPerson(db, '7', ['vorgaenge_einsehen']);
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  const kontoB = createKonto(db, { kontonummer: '4000', bezeichnung: 'Andere', freigeber1Id: '2', stellvertreter1Id: '4', freigeber2Id: '6', stellvertreter2Id: '3' });
  const neuerJob = (name) => createJob(db, { eingangAm: '2026-10-20T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: name, pdfPfad: join(dir, `${name}.pdf`) });
  const zugewiesen = (name, an = '1', konto = kontoId) => {
    const id = neuerJob(name);
    claimJob(db, id, an);
    setKontierung(db, id, konto);
    return id;
  };
  const jobA = zugewiesen('a.pdf');
  const fremd = zugewiesen('fremd.pdf', '2', kontoB);
  const f2 = zugewiesen('f2.pdf');
  createFreigabe(db, { jobId: f2, personId: '1', rolle: 'freigeber1', zeitpunkt: '2026-10-21T08:00:00.000Z', ip: '127.0.0.1', interessenskonflikt: false });
  abschliessenFreigabe1(db, f2);
  const abg = zugewiesen('abg.pdf');
  ablehnenJob(db, abg, { abgelehntVon: '3', grund: 'Betrag falsch' });
  const abrId = createSpesenabrechnung(db, { eingereichtVon: '9', eingereichtAm: '2026-10-21T08:00:00.000Z', titel: 'Spesen' });
  const spesen = createSpesenPosition(db, {
    eingangAm: '2026-10-21T08:00:00.000Z', eingereichtVon: '9', kontoId, betrag: '23.40', auslageDatum: '2026-10-20',
    beschreibung: 'Material', dateiname: 'spesen.pdf', pdfPfad: join(dir, 'spesen.pdf'), thumbnailPfad: null,
    spesenabrechnungId: abrId, zugewiesenAn: '1',
  });
  const fertig = zugewiesen('fertig.pdf');
  db.prepare("UPDATE jobs SET status = 'abgeschlossen' WHERE id = ?").run(fertig);
  db.prepare("INSERT INTO kommentare (job_id, person_id, text, erwaehnt, erstellt_am) VALUES (?, '3', 'Alter Kommentar', '[]', '2026-10-21T09:00:00.000Z')").run(fertig);

  setConfigValue(db, 'modul_kreditkarten_aktiv', '1');
  const karteId = createKreditkarte(db, { bezeichnung: 'Visa Jugend', verantwortlichId: '1', erfassungOffen: true });
  const kk = neuerJob('kk.pdf');
  markiereJobAlsKkAbrechnung(db, kk, { kreditkarteId: karteId, verantwortlichId: '1', ausStatus: 'unzugewiesen' });
  setKontierung(db, kk, kontoId);

  const mailer = { sent: [], async sendMail(m) { this.sent.push(m); } };
  const app = createApp({ db, config, mailer });
  const aussen = express();
  aussen.use((req, res, next) => {
    const personId = req.headers['x-test-person-id'];
    req.session = { id: `sitzung-${personId}`, personId };
    app(req, res, next);
  });
  const als = (personId) => request.agent(aussen).set('x-test-person-id', personId);
  const aufraeumen = async () => {
    // Hintergrund-Zustellung abwarten, bevor die DB schliesst.
    await warteBis(() => db.prepare("SELECT COUNT(*) AS n FROM mail_log WHERE status IN ('eingereiht') AND typ = 'kommentar'").get().n === 0).catch(() => {});
    db.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { db, mailer, als, jobA, fremd, f2, abg, spesen, fertig, kk, aufraeumen };
}

const kommentare = (db, jobId) => db.prepare('SELECT * FROM kommentare WHERE job_id = ? ORDER BY id').all(jobId);
const kommentarMails = (db) => db.prepare("SELECT empfaenger, text FROM mail_log WHERE typ = 'kommentar' ORDER BY id").all();

async function poste(agent, seite, jobId, felder) {
  const token = csrfAus((await agent.get(seite)).text);
  return agent.post(`/kommentare/${jobId}`).type('form').send({ _csrf: token, ...felder });
}

test('POST speichert, leitet auf die Seite mit #kommentare zurück, Mail an Beteiligte, keine an Schreiberin', async () => {
  const u = umgebung();
  const anna = u.als('1');
  const res = await poste(anna, `/kontierung/${u.jobA}`, u.jobA, { text: 'Bitte Betrag prüfen', zurueck: `/kontierung/${u.jobA}` });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, `/kontierung/${u.jobA}#kommentare`);
  const [k] = kommentare(u.db, u.jobA);
  assert.equal(k.text, 'Bitte Betrag prüfen');
  assert.equal(k.person_id, '1');
  const mails = kommentarMails(u.db);
  assert.ok(mails.some((m) => m.empfaenger === 'p3@example.org'), 'Freigeber 2 bekommt eine Mail');
  assert.ok(!mails.some((m) => m.empfaenger === 'p1@example.org'), 'keine Mail an die Schreiberin');
  await warteBis(() => u.mailer.sent.length === mails.length);
  await u.aufraeumen();
});

test('Kommentar ist auf allen sechs Seiten sichtbar (Rolle mit Zugriff), mit Anker id="kommentare"', async () => {
  const u = umgebung();
  const seiten = [
    { person: '1', job: u.jobA, pfad: `/kontierung/${u.jobA}` },
    { person: '3', job: u.f2, pfad: `/freigabe2/${u.f2}` },
    { person: '1', job: u.abg, pfad: `/abgelehnt/${u.abg}` },
    { person: '1', job: u.spesen, pfad: `/spesen-freigabe1/${u.spesen}` },
    { person: '7', job: u.jobA, pfad: `/admin/vorgaenge/${u.jobA}` },
    { person: '3', job: u.jobA, pfad: `/zeitstempel-pruefen?jobId=${u.jobA}` },
  ];
  for (const [i, s] of seiten.entries()) {
    const agent = u.als(s.person);
    const text = `Rückfrage Nummer ${i}`;
    const res = await poste(agent, s.pfad, s.job, { text, zurueck: s.pfad });
    assert.equal(res.status, 302, `${s.pfad}: POST`);
    assert.equal(res.headers.location, `${s.pfad}#kommentare`);
    const seite = await agent.get(s.pfad);
    assert.equal(seite.status, 200, `${s.pfad}: GET`);
    assert.match(seite.text, /id="kommentare"/, `${s.pfad}: Anker`);
    assert.ok(seite.text.includes(text), `${s.pfad}: Kommentar sichtbar`);
    assert.match(seite.text, /name="text"[^>]*maxlength="2000"|maxlength="2000"[^>]*name="text"/, `${s.pfad}: Formular`);
    assert.match(seite.text, /Kommentare können nicht geändert werden/);
    const gelesen = u.db.prepare('SELECT 1 FROM kommentar_gelesen WHERE job_id = ? AND person_id = ?').get(s.job, s.person);
    assert.ok(gelesen, `${s.pfad}: markiereGelesen`);
  }
  await u.aufraeumen();
});

test('Erwähnungshilfe: Auswahl der sichtbaren Personen, ohne JS bleibt der Freitext', async () => {
  const u = umgebung();
  const res = await u.als('1').get(`/kontierung/${u.jobA}`);
  assert.match(res.text, /Person erwähnen/);
  assert.match(res.text, /<option value="Clara Zwei">Clara Zwei<\/option>/);
  assert.doesNotMatch(res.text, /<option value="Emil Fremd">/, 'nicht berechtigte Person fehlt in der Auswahl');
  await u.aufraeumen();
});

test('Review Focus 1: fremde Rechnung → 403, nichts gespeichert, keine Mail', async () => {
  const u = umgebung();
  const anna = u.als('1');
  const res = await poste(anna, `/kontierung/${u.jobA}`, u.fremd, { text: 'Hallo', zurueck: `/kontierung/${u.fremd}` });
  assert.equal(res.status, 403);
  assert.equal(kommentare(u.db, u.fremd).length, 0);
  assert.equal(kommentarMails(u.db).length, 0);
  // Person ganz ohne Zugriff, und ein unbekannter Vorgang.
  const emil = u.als('5');
  assert.equal((await poste(emil, '/pool', u.jobA, { text: 'Hallo' })).status, 403);
  assert.equal((await poste(emil, '/pool', 999999, { text: 'Hallo' })).status, 403);
  assert.equal(kommentare(u.db, u.jobA).length, 0);
  assert.equal(kommentarMails(u.db).length, 0);
  await u.aufraeumen();
});

test('Review Focus 1: @ nicht berechtigte Person → 422 mit Namen, Text bleibt, nichts gespeichert, keine Mail', async () => {
  const u = umgebung();
  const res = await poste(u.als('1'), `/kontierung/${u.jobA}`, u.jobA, { text: 'Bitte @Emil Fremd anschauen', zurueck: `/kontierung/${u.jobA}` });
  assert.equal(res.status, 422);
  assert.match(res.text, /Emil Fremd darf diesen Vorgang nicht sehen/);
  assert.match(res.text, /<textarea[^>]*name="text"[^>]*>Bitte @Emil Fremd anschauen<\/textarea>/);
  assert.match(res.text, /name="zurueck" value="\/kontierung\/\d+"/);
  assert.match(res.text, new RegExp(`href="/kontierung/${u.jobA}#kommentare"`), 'Link zurück');
  assert.equal(kommentare(u.db, u.jobA).length, 0);
  assert.equal(kommentarMails(u.db).length, 0);
  await u.aufraeumen();
});

test('leerer Text → 422 mit Meldung', async () => {
  const u = umgebung();
  const res = await poste(u.als('1'), `/kontierung/${u.jobA}`, u.jobA, { text: '   ', zurueck: `/kontierung/${u.jobA}` });
  assert.equal(res.status, 422);
  assert.match(res.text, /Bitte einen Kommentar eingeben/);
  await u.aufraeumen();
});

test('Review Focus 4: abgeschlossener Vorgang zeigt Liste ohne Formular; Statuswechsel zwischen Seitenaufruf und POST → 422 "abgeschlossen"', async () => {
  const u = umgebung();
  const clara = u.als('3');
  const seite = await clara.get(`/zeitstempel-pruefen?jobId=${u.fertig}`);
  assert.equal(seite.status, 200);
  assert.match(seite.text, /id="kommentare"/);
  assert.match(seite.text, /Alter Kommentar/);
  assert.match(seite.text, /Abgeschlossen — keine neuen Kommentare/);
  assert.doesNotMatch(seite.text, /action="\/kommentare\//);

  const anna = u.als('1');
  const token = csrfAus((await anna.get(`/kontierung/${u.jobA}`)).text);
  u.db.prepare("UPDATE jobs SET status = 'abgeschlossen' WHERE id = ?").run(u.jobA);
  const res = await anna.post(`/kommentare/${u.jobA}`).type('form').send({ _csrf: token, text: 'Noch eine Frage', zurueck: `/kontierung/${u.jobA}` });
  assert.equal(res.status, 422);
  assert.match(res.text, /abgeschlossen/);
  assert.ok(res.text.includes('Noch eine Frage'), 'Text bleibt erhalten');
  assert.equal(kommentare(u.db, u.jobA).length, 0);
  assert.equal(kommentarMails(u.db).length, 0);
  await u.aufraeumen();
});

test('XSS: <script> im Kommentar erscheint escaped, Zeilenumbrüche bleiben (pre-wrap)', async () => {
  const u = umgebung();
  const anna = u.als('1');
  await poste(anna, `/kontierung/${u.jobA}`, u.jobA, { text: '<script>alert(1)</script>\nZeile 2', zurueck: `/kontierung/${u.jobA}` });
  const seite = await anna.get(`/kontierung/${u.jobA}`);
  assert.ok(seite.text.includes('&lt;script&gt;alert(1)&lt;/script&gt;\nZeile 2'));
  assert.ok(!seite.text.includes('<script>alert(1)'));
  assert.match(seite.text, /kommentar-text/);
  await u.aufraeumen();
});

test('offener Redirect: zurueck ausserhalb der festen Liste → Startseite', async () => {
  const u = umgebung();
  const anna = u.als('1');
  const token = csrfAus((await anna.get(`/kontierung/${u.jobA}`)).text);
  const boese = [
    'https://evil.example', '//evil.example', '/\\evil.example', '/%2F%2Fevil.example', '%2F%2Fevil.example',
    `/kontierung/${u.jobA}/../../evil`, `/kontierung/${u.jobA}?x=//evil`, '/kontierungX/1', '/pool', 'javascript:alert(1)', '',
    `/kontierung/${u.jobA}\r\nSet-Cookie: x=1`,
  ];
  for (const zurueck of boese) {
    const res = await anna.post(`/kommentare/${u.jobA}`).type('form').send({ _csrf: token, text: `Test ${zurueck}`, zurueck });
    assert.equal(res.status, 302, `zurueck=${JSON.stringify(zurueck)}`);
    assert.equal(res.headers.location, '/', `zurueck=${JSON.stringify(zurueck)}`);
  }
  // Erlaubte Ziele (tatsächliche Mount-Pfade).
  for (const zurueck of [`/abgelehnt/${u.jobA}`, `/spesen-freigabe1/${u.jobA}`, `/freigabe2/${u.jobA}`, `/admin/vorgaenge/${u.jobA}`, `/zeitstempel-pruefen?jobId=${u.jobA}`]) {
    const res = await anna.post(`/kommentare/${u.jobA}`).type('form').send({ _csrf: token, text: `Ok ${zurueck}`, zurueck });
    assert.equal(res.headers.location, `${zurueck}#kommentare`);
  }
  await u.aufraeumen();
});

test('erfasseKommentar wirft (Einreihen scheitert) → 500-Seite ohne Stack, Text bleibt, nichts gespeichert', async () => {
  const u = umgebung();
  const anna = u.als('1');
  const token = csrfAus((await anna.get(`/kontierung/${u.jobA}`)).text);
  u.db.exec("CREATE TEMP TRIGGER mail_log_kaputt BEFORE INSERT ON mail_log BEGIN SELECT RAISE(ABORT, 'Platte voll'); END");
  const fehler = console.error;
  console.error = () => {};
  let res;
  try {
    res = await anna.post(`/kommentare/${u.jobA}`).type('form').send({ _csrf: token, text: 'Wichtige Rückfrage', zurueck: `/kontierung/${u.jobA}` });
  } finally {
    console.error = fehler;
  }
  assert.equal(res.status, 500);
  assert.match(res.text, /technischen Fehlers nicht gespeichert/);
  assert.ok(res.text.includes('Wichtige Rückfrage'));
  assert.doesNotMatch(res.text, /Platte voll|at .*\.js:\d+/);
  assert.equal(kommentare(u.db, u.jobA).length, 0);
  u.db.exec('DROP TRIGGER mail_log_kaputt');
  await u.aufraeumen();
});

test('fehlende Vorlage kommentar: Kommentar und Mail mit der Standardvorlage', async () => {
  const u = umgebung();
  u.db.prepare("DELETE FROM admin_config WHERE key IN ('mail_vorlage_kommentar_text', 'mail_vorlage_kommentar_betreff')").run();
  const res = await poste(u.als('1'), `/kontierung/${u.jobA}`, u.jobA, { text: 'Trotzdem speichern', zurueck: `/kontierung/${u.jobA}` });
  assert.equal(res.status, 302);
  assert.equal(kommentare(u.db, u.jobA).length, 1);
  const [mail] = kommentarMails(u.db);
  assert.match(mail.text, /Trotzdem speichern/);
  assert.match(mail.text, /hat einen Kommentar zum Vorgang/);
  await u.aufraeumen();
});

test('Mail-Link je Empfänger zeigt auf eine Seite mit Kommentarbereich', async () => {
  const u = umgebung();
  await poste(u.als('1'), `/kontierung/${u.jobA}`, u.jobA, { text: 'Hallo @Gina Einsicht', zurueck: `/kontierung/${u.jobA}` });
  const mails = kommentarMails(u.db);
  const clara = mails.find((m) => m.empfaenger === 'p3@example.org');
  assert.match(clara.text, new RegExp(`/zeitstempel-pruefen\\?jobId=${u.jobA}#kommentare`));
  const gina = mails.find((m) => m.empfaenger === 'p7@example.org');
  assert.match(gina.text, new RegExp(`/admin/vorgaenge/${u.jobA}#kommentare`));
  await u.aufraeumen();
});

test('Spesen-Einreicherin kommentiert über /zeitstempel-pruefen?jobId=…', async () => {
  const u = umgebung();
  const ida = u.als('9');
  const pfad = `/zeitstempel-pruefen?jobId=${u.spesen}`;
  const seite = await ida.get(pfad);
  assert.equal(seite.status, 200);
  assert.match(seite.text, /action="\/kommentare\/\d+"/);
  const res = await poste(ida, pfad, u.spesen, { text: 'Beleg nachgereicht', zurueck: pfad });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, `${pfad}#kommentare`);
  assert.equal(kommentare(u.db, u.spesen).length, 1);
  await u.aufraeumen();
});

test('/admin/mail-einstellungen zeigt die Vorlage kommentar zum Bearbeiten', async () => {
  const u = umgebung();
  const res = await u.als('6').get('/admin/mail-einstellungen');
  assert.equal(res.status, 200);
  assert.match(res.text, /name="kommentarBetreff"/);
  assert.match(res.text, /name="kommentarText"/);
  await u.aufraeumen();
});

test('Review Focus 5: Testmodus – Kommentar nur in der Spiel-DB und im Test-Postfach', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kommentare-testmodus-'));
  const config = {
    ...testConfig(dir),
    dbPath: join(dir, 'echt.sqlite'), jobsDir: join(dir, 'jobs'), brandingDir: join(dir, 'branding'), backupDir: join(dir, 'backups'),
    backupKeyringFile: join(dir, 'keyring.json'),
  };
  for (const d of [config.jobsDir, config.brandingDir, config.backupDir]) mkdirSync(d, { recursive: true });
  const echteDb = openDatabase(config.dbPath);
  seedDefaults(echteDb);
  const sp = await erstelleSpielwiese(echteDb, config);
  const testMailer = createTestMailer();
  const testApp = createApp({ db: sp.db, config: sp.config, mailer: testMailer, testmodus: true });
  const aussen = express();
  aussen.use((req, res, next) => {
    req.session = { id: 'sitzung-test', personId: 'echt-admin', testmodus: { personId: 'test-1' } };
    testApp(req, res, next);
  });
  const agent = request.agent(aussen);
  const job = sp.db.prepare("SELECT id FROM jobs WHERE dateiname = 'Rechnung bei Anna.pdf'").get();
  const seite = await agent.get(`/kontierung/${job.id}`);
  assert.equal(seite.status, 200);
  assert.match(seite.text, /id="kommentare"/);
  const res = await agent.post(`/kommentare/${job.id}`).type('form').send({ _csrf: csrfAus(seite.text), text: 'Spielwiese', zurueck: `/kontierung/${job.id}` });
  assert.equal(res.status, 302);
  assert.equal(sp.db.prepare('SELECT COUNT(*) AS n FROM kommentare').get().n, 1);
  assert.equal(echteDb.prepare('SELECT COUNT(*) AS n FROM kommentare').get().n, 0);
  assert.equal(echteDb.prepare("SELECT COUNT(*) AS n FROM mail_log WHERE typ = 'kommentar'").get().n, 0);
  await warteBis(() => testMailer.gesendet.length > 0);
  assert.ok(testMailer.gesendet.every((m) => String(m.to).endsWith('@beispiel.invalid')));
  await warteBis(() => sp.db.prepare("SELECT COUNT(*) AS n FROM mail_log WHERE typ = 'kommentar' AND status = 'eingereiht'").get().n === 0).catch(() => {});
  sp.db.close();
  echteDb.close();
  rmSync(dir, { recursive: true, force: true });
});

test('Kontierung: Warnung vor ungespeicherten Kontierungsangaben beim Absenden eines Kommentars', async () => {
  const u = umgebung();
  const res = await u.als('1').get(`/kontierung/${u.jobA}`);
  assert.match(res.text, /<form method="post" action="\/kommentare\/\d+" class="kommentar-form" id="kommentar-form-\d+" data-ungespeichert-warnung="kontierung-form">/);
  assert.match(res.text, /<form id="kontierung-form"/);
  assert.match(res.text, /dataset\.ungespeichertWarnung/);
  assert.match(res.text, /window\.confirm\('Ungespeicherte Angaben/);
  // Seiten ohne Arbeitsformular bekommen den Haken nicht.
  const vorgang = await u.als('7').get(`/admin/vorgaenge/${u.jobA}`);
  assert.doesNotMatch(vorgang.text, /data-ungespeichert-warnung/);
  await u.aufraeumen();
});

test('KK-Abgleich: Kommentarbereich, Rücksprung dorthin, Mail-Link der verantwortlichen Person', async () => {
  const u = umgebung();
  const pfad = `/kontierung/${u.kk}/kk-abgleich`;
  const clara = u.als('3');
  const res = await poste(clara, `/zeitstempel-pruefen?jobId=${u.kk}`, u.kk, { text: 'Frage zur Abrechnung', zurueck: `/zeitstempel-pruefen?jobId=${u.kk}` });
  assert.equal(res.status, 302);
  const mail = kommentarMails(u.db).find((m) => m.empfaenger === 'p1@example.org');
  assert.match(mail.text, new RegExp(`/kontierung/${u.kk}/kk-abgleich#kommentare`));

  const anna = u.als('1');
  const seite = await anna.get(pfad);
  assert.equal(seite.status, 200);
  assert.match(seite.text, /id="kommentare"/);
  assert.ok(seite.text.includes('Frage zur Abrechnung'));
  assert.match(seite.text, /data-ungespeichert-warnung="kk-abgleich-form"/);
  assert.ok(u.db.prepare('SELECT 1 FROM kommentar_gelesen WHERE job_id = ? AND person_id = ?').get(u.kk, '1'));
  const antwort = await poste(anna, pfad, u.kk, { text: 'Antwort', zurueck: pfad });
  assert.equal(antwort.headers.location, `${pfad}#kommentare`);
  // Fremde Person: Seite verweigert, kein Gelesen-Eintrag.
  const emil = await u.als('5').get(pfad);
  assert.equal(emil.status, 403);
  assert.ok(!u.db.prepare("SELECT 1 FROM kommentar_gelesen WHERE job_id = ? AND person_id = '5'").get(u.kk));
  await u.aufraeumen();
});
