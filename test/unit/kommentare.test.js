import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../../src/db/index.js';
import { seedDefaults } from '../../src/db/adminConfigRepo.js';
import { upsertPerson, getPersonById, setFerienmodus } from '../../src/db/personenRepo.js';
import { createKonto } from '../../src/db/kontenRepo.js';
import { createJob, claimJob, setKontierung, getJobById } from '../../src/db/jobsRepo.js';
import { setBerechtigungenForPerson } from '../../src/db/personBerechtigungenRepo.js';
import { getVorlage } from '../../src/services/mailTemplates.js';
import {
  KOMMENTAR_GESCHLOSSEN_STATUS,
  darfKommentareSehen,
  darfKommentieren,
  erwaehnbarePersonen,
  findeErwaehnungen,
  beteiligte,
  erfasseKommentar,
  listeKommentare,
  kommentarInfo,
  markiereGelesen,
} from '../../src/services/kommentare.js';

const CONFIG = { publicBaseUrl: 'https://portal.example.org', churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20', groupIdManager: '30' } };

const PERSONEN = [
  ['1', 'Anna', 'Beispiel', []],
  ['2', 'Bruno', 'Stell', []],
  ['3', 'Clara', 'Zwei', []],
  ['4', 'Dora', 'Vier', []],
  ['5', 'Emil', 'Fremd', []],
  ['6', 'Fritz', 'Admin', ['20']],
  ['7', 'Gina', 'Einsicht', []],
  ['8', 'Hans', 'Ferien', []],
  ['9', 'Ida', 'Spesen', []],
  ['10', 'Anna', 'Beispiel-Muster', []],
];

function stubMailer() {
  const sent = [];
  return { sent, async sendMail(mail) { sent.push(mail); } };
}

function setup() {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  for (const [id, vorname, nachname, gruppen] of PERSONEN) {
    upsertPerson(db, { id, vorname, nachname, email: `p${id}@example.org`, gruppen, loggedInNow: true });
  }
  setBerechtigungenForPerson(db, '7', ['vorgaenge_einsehen']);
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  const jobId = createJob(db, { eingangAm: '2026-10-20T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'rechnung.pdf', pdfPfad: '/tmp/r.pdf' });
  claimJob(db, jobId, '1');
  setKontierung(db, jobId, kontoId);
  return { db, kontoId, jobId, job: () => getJobById(db, jobId), p: (id) => getPersonById(db, id) };
}

function setStatus(db, jobId, status) {
  db.prepare('UPDATE jobs SET status = ? WHERE id = ?').run(status, jobId);
}

test('Tabelle kommentare: angelegt, unveränderlich, INSERT erscheint im Audit', () => {
  const { db, jobId } = setup();
  const id = Number(db.prepare("INSERT INTO kommentare (job_id, person_id, text, erstellt_am) VALUES (?, '1', 'Hallo', '2026-10-25T08:00:00.000Z')").run(jobId).lastInsertRowid);
  assert.throws(() => db.prepare("UPDATE kommentare SET text = 'x' WHERE id = ?").run(id), /kommentare ist unveraenderlich/);
  assert.throws(() => db.prepare('DELETE FROM kommentare WHERE id = ?').run(id), /kommentare ist unveraenderlich/);
  const audit = db.prepare("SELECT * FROM audit_ereignisse WHERE objekt = 'kommentare' AND objekt_id = ?").all(String(id));
  assert.equal(audit.length, 1);
  assert.match(audit[0].nachher, /Hallo/);
  assert.throws(() => db.prepare("INSERT INTO kommentare (job_id, person_id, text, erstellt_am) VALUES (?, '1', '', 'x')").run(jobId));
  assert.throws(() => db.prepare("INSERT INTO kommentare (job_id, person_id, text, erstellt_am) VALUES (?, '1', ?, 'x')").run(jobId, 'a'.repeat(2001)));
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND tbl_name = 'kommentare' AND sql LIKE '%job_id%'").get());
  db.close();
});

test('kommentar_gelesen darf aktualisiert werden', () => {
  const { db, jobId } = setup();
  db.prepare("INSERT INTO kommentar_gelesen (job_id, person_id, zuletzt_am) VALUES (?, '1', 'a')").run(jobId);
  db.prepare("UPDATE kommentar_gelesen SET zuletzt_am = 'b' WHERE job_id = ?").run(jobId);
  assert.equal(db.prepare('SELECT zuletzt_am FROM kommentar_gelesen').get().zuletzt_am, 'b');
  db.close();
});

const mailInsert = (typ) => `INSERT INTO mail_log (typ, empfaenger, betreff, text, status, versucht_am) VALUES ('${typ}', 'a@b.ch', 's', 't', 'versendet', '2026-10-25T00:00:00Z')`;

test('mail_log akzeptiert kommentar, auch nach Migration einer alten DB', () => {
  const frisch = openDatabase(':memory:');
  assert.doesNotThrow(() => frisch.prepare(mailInsert('kommentar')).run());
  frisch.close();

  const dir = mkdtempSync(join(tmpdir(), 'kommentare-schema-'));
  const pfad = join(dir, 'portal.db');
  let db = openDatabase(pfad);
  db.prepare(mailInsert('testmail')).run();
  db.close();
  const raw = new DatabaseSync(pfad);
  const sql = raw.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'mail_log'").get().sql;
  raw.exec('PRAGMA writable_schema = ON');
  raw.prepare("UPDATE sqlite_master SET sql = ? WHERE type = 'table' AND name = 'mail_log'").run(sql.replace(", 'kommentar'", ''));
  raw.exec('PRAGMA writable_schema = OFF');
  raw.close();
  db = openDatabase(pfad);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM mail_log WHERE typ = 'testmail'").get().n, 1);
  assert.doesNotThrow(() => db.prepare(mailInsert('kommentar')).run());
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'mail_log_zustellung_idx'").get());
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('Vorlage kommentar ist vorhanden', () => {
  const { db } = setup();
  const v = getVorlage(db, 'kommentar');
  assert.ok(v.betreff && v.text);
  for (const variable of ['%verfasserName%', '%kommentarText%', '%link%', '%jobDateiname%']) {
    assert.ok((v.betreff + v.text).includes(variable), variable);
  }
  db.close();
});

test('Sichtbarkeit je Rolle', () => {
  const { db, jobId, job, p } = setup();
  // zugewiesen an Anna (1)
  assert.equal(darfKommentareSehen(db, CONFIG, p('1'), job()), true, 'zuständig');
  assert.equal(darfKommentareSehen(db, CONFIG, p('3'), job()), true, 'F2');
  assert.equal(darfKommentareSehen(db, CONFIG, p('5'), job()), false, 'fremd');
  assert.equal(darfKommentareSehen(db, CONFIG, p('6'), job()), true, 'superadmin');
  assert.equal(darfKommentareSehen(db, CONFIG, p('7'), job()), true, 'vorgaenge_einsehen');
  assert.equal(darfKommentareSehen(db, CONFIG, p('8'), job()), false, 'noch keine Vertretung');
  setFerienmodus(db, '1', { von: '2000-01-01', bis: '2999-01-01', stellvertreterId: '8' });
  assert.equal(darfKommentareSehen(db, CONFIG, p('8'), job()), true, 'Vertretung');
  assert.equal(darfKommentareSehen(db, CONFIG, null, job()), false);

  const spesenId = createJob(db, { eingangAm: '2026-10-20T08:00:00.000Z', quelle: 'spesen', absender: null, dateiname: 's.pdf', pdfPfad: '/tmp/s.pdf' });
  db.prepare("UPDATE jobs SET eingereicht_von = '9', status = 'zugewiesen', zugewiesen_an = '1' WHERE id = ?").run(spesenId);
  assert.equal(darfKommentareSehen(db, CONFIG, p('9'), getJobById(db, spesenId)), true, 'Einreicherin');
  assert.equal(darfKommentareSehen(db, CONFIG, p('9'), job()), false);
  db.close();
  void jobId;
});

test('darfKommentieren false für jeden geschlossenen Status', () => {
  const { db, jobId, job, p } = setup();
  assert.deepEqual([...KOMMENTAR_GESCHLOSSEN_STATUS].sort(), ['abgeholt', 'abgeschlossen', 'archiviert', 'geloescht']);
  assert.equal(darfKommentieren(db, CONFIG, p('1'), job()), true);
  assert.equal(darfKommentieren(db, CONFIG, p('5'), job()), false);
  for (const status of KOMMENTAR_GESCHLOSSEN_STATUS) {
    setStatus(db, jobId, status);
    assert.equal(darfKommentieren(db, CONFIG, p('6'), job()), false, status);
    assert.equal(darfKommentareSehen(db, CONFIG, p('6'), job()), true, status);
  }
  db.close();
});

test('findeErwaehnungen', () => {
  const kandidaten = [
    { id: '1', name: 'Anna Beispiel' },
    { id: '10', name: 'Anna Beispiel-Muster' },
    { id: '3', name: 'Clara Zwei' },
  ];
  assert.deepEqual(findeErwaehnungen('Frage an @Anna Beispiel bitte', kandidaten), { ids: ['1'], unbekannt: [] });
  assert.deepEqual(findeErwaehnungen('@anna beispiel, was meinst du?', kandidaten), { ids: ['1'], unbekannt: [] });
  assert.deepEqual(findeErwaehnungen('@Anna Beispiel-Muster und @CLARA ZWEI', kandidaten), { ids: ['10', '3'], unbekannt: [] });
  assert.deepEqual(findeErwaehnungen('@Unbekannt hallo', kandidaten), { ids: [], unbekannt: ['Unbekannt'] });
  assert.deepEqual(findeErwaehnungen('@Anna Beispiel @Anna Beispiel', kandidaten), { ids: ['1'], unbekannt: [] });
  assert.deepEqual(findeErwaehnungen('Mail an info@example.org', kandidaten), { ids: [], unbekannt: [] });
  assert.deepEqual(findeErwaehnungen('@Anna Beispielhaft', kandidaten), { ids: [], unbekannt: ['Anna Beispielhaft'] });
});

test('erwaehnbarePersonen: nur Berechtigte, nach Name sortiert', () => {
  const { db, job } = setup();
  const liste = erwaehnbarePersonen(db, CONFIG, job());
  const ids = liste.map((x) => x.id);
  assert.ok(ids.includes('1') && ids.includes('3') && ids.includes('6') && ids.includes('7'));
  assert.ok(!ids.includes('5') && !ids.includes('9'));
  const namen = liste.map((x) => x.name);
  assert.deepEqual(namen, [...namen].sort((a, b) => a.localeCompare(b, 'de')));
  db.close();
});

test('beteiligte: ohne Schreiber, ohne Duplikate, Vertretung, Admin nur bei Erwähnung', () => {
  const { db, job } = setup();
  setFerienmodus(db, '3', { von: '2000-01-01', bis: '2999-01-01', stellvertreterId: '8' });
  const ohne = beteiligte(db, CONFIG, job(), { schreiberId: '1', erwaehntIds: ['3'] });
  assert.equal(new Set(ohne).size, ohne.length);
  assert.ok(!ohne.includes('1'));
  assert.ok(ohne.includes('3') && ohne.includes('8'));
  assert.ok(!ohne.includes('6') && !ohne.includes('7') && !ohne.includes('5'));
  const mit = beteiligte(db, CONFIG, job(), { schreiberId: '1', erwaehntIds: ['6', '5'] });
  assert.ok(mit.includes('6'));
  assert.ok(!mit.includes('5'), 'nicht berechtigte Erwähnte nie');
  db.close();
});

test('erfasseKommentar: speichert, mailt Beteiligte genau einmal, nie den Schreiber', async () => {
  const { db, jobId, job, p } = setup();
  const mailer = stubMailer();
  const r = await erfasseKommentar(db, CONFIG, mailer, { job: job(), person: p('3'), text: '  Ist das @Anna Beispiel recht?\nZweite Zeile  ' });
  assert.equal(r.ok, true);
  const liste = listeKommentare(db, jobId);
  assert.equal(liste.length, 1);
  assert.equal(liste[0].text, 'Ist das @Anna Beispiel recht?\nZweite Zeile');
  assert.equal(liste[0].verfasser_name, 'Clara Zwei');
  assert.equal(liste[0].person_id, '3');
  assert.deepEqual(JSON.parse(db.prepare('SELECT erwaehnt FROM kommentare WHERE id = ?').get(r.id).erwaehnt), ['1']);
  const an = mailer.sent.map((m) => m.to).sort();
  assert.deepEqual(an, ['p1@example.org']);
  assert.match(mailer.sent[0].text, /Zweite Zeile/);
  assert.match(mailer.sent[0].text, /Clara Zwei/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM mail_log WHERE typ = 'kommentar'").get().n, 1);

  // Antwort von Anna: Clara (frühere Kommentierende + F2) bekommt genau eine Mail.
  mailer.sent.length = 0;
  const r2 = await erfasseKommentar(db, CONFIG, mailer, { job: job(), person: p('1'), text: 'Ja, passt.' });
  assert.equal(r2.ok, true);
  assert.deepEqual(mailer.sent.map((m) => m.to), ['p3@example.org']);
  assert.deepEqual(listeKommentare(db, jobId).map((k) => k.text), ['Ist das @Anna Beispiel recht?\nZweite Zeile', 'Ja, passt.']);
  db.close();
});

test('erfasseKommentar: Admin ohne Rolle nur bei Erwähnung', async () => {
  const { db, job, p } = setup();
  const mailer = stubMailer();
  await erfasseKommentar(db, CONFIG, mailer, { job: job(), person: p('1'), text: 'Ohne Erwähnung' });
  assert.ok(!mailer.sent.some((m) => m.to === 'p6@example.org' || m.to === 'p7@example.org'));
  mailer.sent.length = 0;
  await erfasseKommentar(db, CONFIG, mailer, { job: job(), person: p('1'), text: '@Fritz Admin bitte schauen' });
  assert.ok(mailer.sent.some((m) => m.to === 'p6@example.org'));
  assert.ok(!mailer.sent.some((m) => m.to === 'p7@example.org'));
  db.close();
});

test('erfasseKommentar: Fehlerfälle', async () => {
  const { db, jobId, job, p } = setup();
  const mailer = stubMailer();
  for (const text of ['', '   ', 'a'.repeat(2001)]) {
    const r = await erfasseKommentar(db, CONFIG, mailer, { job: job(), person: p('1'), text });
    assert.equal(r.ok, false, JSON.stringify(text.slice(0, 5)));
    assert.ok(r.fehler.length >= 1);
  }
  assert.equal((await erfasseKommentar(db, CONFIG, mailer, { job: job(), person: p('1'), text: 'a'.repeat(2000) })).ok, true);
  const unbekannt = await erfasseKommentar(db, CONFIG, mailer, { job: job(), person: p('1'), text: '@Unbekannt hallo' });
  assert.equal(unbekannt.ok, false);
  assert.match(unbekannt.fehler.join(' '), /Unbekannt/);
  const fremd = await erfasseKommentar(db, CONFIG, mailer, { job: job(), person: p('1'), text: '@Emil Fremd schau mal' });
  assert.equal(fremd.ok, false);
  assert.match(fremd.fehler.join(' '), /Emil Fremd/);
  const ohneRecht = await erfasseKommentar(db, CONFIG, mailer, { job: job(), person: p('5'), text: 'Hallo' });
  assert.equal(ohneRecht.ok, false);
  setStatus(db, jobId, 'abgeschlossen');
  const zu = await erfasseKommentar(db, CONFIG, mailer, { job: job(), person: p('1'), text: 'Hallo' });
  assert.equal(zu.ok, false);
  assert.equal(listeKommentare(db, jobId).length, 1);
  db.close();
});

test('kommentarInfo zählt neu vor/nach markiereGelesen', async () => {
  const { db, jobId, job, p } = setup();
  const mailer = stubMailer();
  const andererId = createJob(db, { eingangAm: '2026-10-20T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'b.pdf', pdfPfad: '/tmp/b.pdf' });
  await erfasseKommentar(db, CONFIG, mailer, { job: job(), person: p('3'), text: 'Eins', jetzt: new Date('2026-10-25T08:00:00.000Z') });
  await erfasseKommentar(db, CONFIG, mailer, { job: job(), person: p('1'), text: 'Zwei', jetzt: new Date('2026-10-25T08:01:00.000Z') });
  let info = kommentarInfo(db, [jobId, andererId], '1');
  assert.deepEqual(info.get(jobId), { anzahl: 2, neu: 1 });
  assert.equal(info.has(andererId), false);
  markiereGelesen(db, jobId, '1', new Date('2026-10-25T08:02:00.000Z'));
  assert.deepEqual(kommentarInfo(db, [jobId], '1').get(jobId), { anzahl: 2, neu: 0 });
  await erfasseKommentar(db, CONFIG, mailer, { job: job(), person: p('3'), text: 'Drei', jetzt: new Date('2026-10-25T08:03:00.000Z') });
  assert.deepEqual(kommentarInfo(db, [jobId], '1').get(jobId), { anzahl: 3, neu: 1 });
  markiereGelesen(db, jobId, '1', new Date('2026-10-25T08:04:00.000Z'));
  assert.deepEqual(kommentarInfo(db, [jobId], '1').get(jobId), { anzahl: 3, neu: 0 });
  assert.deepEqual(kommentarInfo(db, [jobId], '3').get(jobId), { anzahl: 3, neu: 1 });
  assert.equal(kommentarInfo(db, [], '1').size, 0);
  db.close();
});
