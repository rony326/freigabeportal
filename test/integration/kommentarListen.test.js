// Anzahl und "neu" in den Vorgangslisten (Task 3, docs/superpowers/specs/2026-10-25-kommentare-design.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/db/index.js';
import { seedDefaults } from '../../src/db/adminConfigRepo.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createKonto } from '../../src/db/kontenRepo.js';
import { createJob, claimJob, setKontierung, ablehnenJob, createSpesenPosition } from '../../src/db/jobsRepo.js';
import { createSpesenabrechnung } from '../../src/db/spesenabrechnungenRepo.js';
import { setBerechtigungenForPerson } from '../../src/db/personBerechtigungenRepo.js';
import { createApp } from '../../src/app.js';

function testConfig(dir) {
  return {
    sessionSecret: 'test-secret', env: 'test', publicBaseUrl: 'http://portal.example.org',
    churchtools: {
      baseUrl: 'https://ct.example.org', clientId: 'client-id', clientSecret: 'client-secret',
      redirectUri: 'https://portal.example.org/auth/callback', groupIdBuchhaltung: '10', groupIdAdmin: '20', syncServiceToken: 'token',
    },
    cronSecret: 'cron-secret', n8nApiKey: 'n8n-key',
    smtp: { host: 'smtp.example.org', port: 587, user: 'user', pass: 'pass', from: 'portal@example.org' },
    brandingDir: dir, jobsDir: dir, backupDir: dir, downloadSigningSecret: 'download-secret',
  };
}

const PERSONEN = [
  ['1', 'Anna', 'Beispiel', []],
  ['2', 'Bruno', 'Stell', []],
  ['3', 'Clara', 'Zwei', []],
  ['4', 'Dora', 'Vier', []],
  ['6', 'Fritz', 'Admin', ['20']],
  ['7', 'Gina', 'Einsicht', []],
  ['8', 'Hans', 'Rechte', []],
  ['9', 'Ida', 'Spesen', []],
];

function umgebung() {
  const dir = mkdtempSync(join(tmpdir(), 'kommentarlisten-'));
  const config = testConfig(dir);
  const db = openDatabase(':memory:');
  seedDefaults(db);
  for (const [id, vorname, nachname, gruppen] of PERSONEN) {
    upsertPerson(db, { id, vorname, nachname, email: `p${id}@example.org`, gruppen, loggedInNow: true });
  }
  setBerechtigungenForPerson(db, '7', ['vorgaenge_einsehen']);
  setBerechtigungenForPerson(db, '8', ['abgelehnt_verwalten', 'pool_zuweisen']);
  const konto = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  const zugewiesen = (name) => {
    const id = createJob(db, { eingangAm: '2026-10-20T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: name, pdfPfad: join(dir, name) });
    claimJob(db, id, '1');
    setKontierung(db, id, konto);
    return id;
  };
  const mitKommentar = zugewiesen('mit.pdf');
  const ohne = zugewiesen('ohne.pdf');
  const eigen = zugewiesen('eigen.pdf');
  ablehnenJob(db, eigen, { abgelehntVon: '3', grund: 'Betrag falsch' });
  const fertig = zugewiesen('fertig.pdf');
  db.prepare("UPDATE jobs SET status = 'abgeschlossen' WHERE id = ?").run(fertig);
  const abrId = createSpesenabrechnung(db, { eingereichtVon: '9', eingereichtAm: '2026-10-21T08:00:00.000Z', titel: 'Spesen' });
  const spesen = createSpesenPosition(db, {
    eingangAm: '2026-10-21T08:00:00.000Z', eingereichtVon: '9', kontoId: konto, betrag: '23.40', auslageDatum: '2026-10-20',
    beschreibung: 'Material', dateiname: 'spesen.pdf', pdfPfad: join(dir, 'spesen.pdf'), thumbnailPfad: null,
    spesenabrechnungId: abrId, zugewiesenAn: '1',
  });
  const kommentar = (jobId, personId, zeit) =>
    db.prepare("INSERT INTO kommentare (job_id, person_id, text, erwaehnt, erstellt_am) VALUES (?, ?, 'Text', '[]', ?)").run(jobId, personId, zeit);
  const rueck = createJob(db, { eingangAm: '2026-10-20T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'rueck.pdf', pdfPfad: join(dir, 'rueck.pdf') });
  db.prepare("UPDATE jobs SET pool_rueckgesendet_bemerkung = 'zurück', pool_rueckgesendet_von = '1', pool_rueckgesendet_am = '2026-10-21T08:00:00.000Z' WHERE id = ?").run(rueck);
  kommentar(rueck, '3', '2026-10-22T10:00:00.000Z');
  kommentar(mitKommentar, '3', '2026-10-22T08:00:00.000Z');
  kommentar(mitKommentar, '3', '2026-10-22T09:00:00.000Z');
  kommentar(mitKommentar, '1', '2026-10-22T10:00:00.000Z'); // eigener Kommentar von Anna
  kommentar(eigen, '1', '2026-10-22T10:00:00.000Z'); // nur eigene
  kommentar(fertig, '3', '2026-10-22T10:00:00.000Z');
  kommentar(spesen, '3', '2026-10-22T10:00:00.000Z');

  const mailer = { sent: [], async sendMail(m) { this.sent.push(m); } };
  const app = createApp({ db, config, mailer });
  const aussen = express();
  aussen.use((req, res, next) => {
    const personId = req.headers['x-test-person-id'];
    req.session = { id: `sitzung-${personId}`, personId };
    app(req, res, next);
  });
  const als = (personId) => request.agent(aussen).set('x-test-person-id', personId);
  const aufraeumen = () => { db.close(); rmSync(dir, { recursive: true, force: true }); };
  return { db, als, rueck, mitKommentar, ohne, eigen, fertig, spesen, aufraeumen };
}

// Ausschnitt einer Tabellenzeile bzw. Kachel anhand ihrer id.
function ausschnitt(text, idMuster) {
  const m = new RegExp(`id="${idMuster}"`).exec(text);
  assert.ok(m, `Eintrag ${idMuster} fehlt`);
  const ab = text.slice(m.index);
  const ende = idMuster.includes('kachel') ? ab.indexOf('</dl>') : ab.indexOf('</tr>');
  return ende === -1 ? ab : ab.slice(0, ende);
}

test('Aufgaben (Pool-Seite): Tabelle und Kacheln zeigen Anzahl und "neu" (eigene zählen nicht als neu)', async () => {
  const u = umgebung();
  const res = await u.als('1').get('/pool');
  assert.equal(res.status, 200);
  for (const teil of [`row-${u.mitKommentar}`, `kachel-${u.mitKommentar}`]) {
    const a = ausschnitt(res.text, `[a-zA-Z-]*${teil}`);
    assert.match(a, /aria-label="3 Kommentare, davon 2 neu"/, teil);
    assert.match(a, />neu</, teil);
  }
  for (const teil of [`row-${u.eigen}`, `kachel-${u.eigen}`]) {
    const a = ausschnitt(res.text, `[a-zA-Z-]*${teil}`);
    assert.match(a, /aria-label="1 Kommentar, davon 0 neu"/, teil);
    assert.doesNotMatch(a, />neu</, teil);
  }
  for (const teil of [`row-${u.ohne}`, `kachel-${u.ohne}`]) {
    assert.doesNotMatch(ausschnitt(res.text, `[a-zA-Z-]*${teil}`), /kommentar-marke/, teil);
  }
  u.aufraeumen();
});

test('"neu" verschwindet, nachdem die Detailseite geöffnet wurde', async () => {
  const u = umgebung();
  const anna = u.als('1');
  assert.match((await anna.get('/pool')).text, /davon 2 neu/);
  assert.equal((await anna.get(`/kontierung/${u.mitKommentar}`)).status, 200);
  const danach = await anna.get('/pool');
  assert.doesNotMatch(danach.text, /davon 2 neu/);
  assert.match(danach.text, /aria-label="3 Kommentare, davon 0 neu"/);
  u.aufraeumen();
});

test('Meine Spesen: Tabelle und Kacheln zeigen die Marke', async () => {
  const u = umgebung();
  const res = await u.als('9').get('/meine-spesen');
  assert.equal(res.status, 200);
  for (const teil of [`spesen-meine-row-${u.spesen}`, `spesen-meine-kachel-${u.spesen}`]) {
    assert.match(ausschnitt(res.text, teil), /aria-label="1 Kommentar, davon 1 neu"/, teil);
  }
  u.aufraeumen();
});

test('Meine abgeschlossenen: Tabelle und Kacheln zeigen die Marke', async () => {
  const u = umgebung();
  const res = await u.als('1').get('/meine-abgeschlossenen');
  assert.equal(res.status, 200);
  for (const teil of [`abgeschlossen-row-${u.fertig}`, `abgeschlossen-kachel-${u.fertig}`]) {
    assert.match(ausschnitt(res.text, teil), /aria-label="1 Kommentar, davon 1 neu"/, teil);
  }
  u.aufraeumen();
});

test('Admin Vorgänge: Tabelle und Kacheln zeigen die Marke, Vorgang ohne Kommentare keine', async () => {
  const u = umgebung();
  const res = await u.als('7').get('/admin/vorgaenge');
  assert.equal(res.status, 200);
  assert.match(ausschnitt(res.text, `vorgang-kachel-${u.mitKommentar}`), /aria-label="3 Kommentare, davon 3 neu"/);
  assert.doesNotMatch(ausschnitt(res.text, `vorgang-kachel-${u.ohne}`), /kommentar-marke/);
  // Tabelle: Zeile mit dem Link auf den Vorgang.
  const zeilen = res.text.split('<tr').filter((z) => z.includes(`/admin/vorgaenge/${u.mitKommentar}"`));
  assert.ok(zeilen.length >= 1);
  assert.match(zeilen[0], /aria-label="3 Kommentare, davon 3 neu"/);
  u.aufraeumen();
});

test('Admin abgelehnt: Tabelle und Kacheln zeigen die Marke', async () => {
  const u = umgebung();
  const res = await u.als('6').get('/admin/abgelehnt');
  assert.equal(res.status, 200);
  assert.match(ausschnitt(res.text, `abgelehnt-kachel-${u.eigen}`), /kommentar-marke/);
  const zeilen = res.text.split('<tr').filter((z) => z.includes(`/admin/abgelehnt/${u.eigen}"`));
  assert.match(zeilen[0], /kommentar-marke/);
  u.aufraeumen();
});

test('Partials ohne kommentarInfo stürzen nicht ab', async () => {
  const ejs = (await import('ejs')).default;
  const job = { id: 1, dateiname: 'a.pdf', status: 'abgeschlossen', eingang_am: '2026-10-20T08:00:00.000Z', betrag: '1', beschreibung: 'x', ablehnungsgrund: null };
  for (const v of ['_abgeschlossen_table', '_abgeschlossen_kacheln', '_spesen_meine_tabelle', '_spesen_meine_kacheln']) {
    const html = await ejs.renderFile(new URL(`../../views/${v}.ejs`, import.meta.url).pathname, { jobs: [job], testmodus: false, csrfToken: 't' }, { views: [new URL('../../views', import.meta.url).pathname] });
    assert.doesNotMatch(html, /kommentar-marke/);
  }
});

test('Admin abgelehnt: ohne Sichtrecht auf den Vorgang keine Marke (nur abgelehnt_verwalten)', async () => {
  const u = umgebung();
  const res = await u.als('8').get('/admin/abgelehnt');
  assert.equal(res.status, 200);
  assert.ok(res.text.includes(`/admin/abgelehnt/${u.eigen}`), 'Vorgang ist in der Liste');
  assert.doesNotMatch(res.text, /kommentar-marke/);
  u.aufraeumen();
});

test('Pool Rückläufer: pool_zuweisen ohne Sichtrecht sieht keine Marke, Buchhaltung/Superadmin schon', async () => {
  const u = umgebung();
  const res = await u.als('8').get('/pool');
  assert.equal(res.status, 200);
  assert.ok(res.text.includes('rueck.pdf') || res.text.includes(`row-${u.rueck}`), 'Rückläufer ist in der Liste');
  assert.doesNotMatch(res.text, /kommentar-marke/);
  const admin = await u.als('6').get('/pool');
  assert.match(admin.text, /1 Kommentar, davon 1 neu/);
  u.aufraeumen();
});

test('Marke: Singular/Plural im aria-label, SVG statt Emoji', async () => {
  const u = umgebung();
  const res = await u.als('1').get('/pool');
  assert.match(res.text, /aria-label="3 Kommentare, davon 2 neu"/);
  assert.match(res.text, /aria-label="1 Kommentar, davon 0 neu"/);
  assert.match(res.text, /kommentar-marke[^]*?<svg/);
  assert.doesNotMatch(res.text, /💬/);
  u.aufraeumen();
});
