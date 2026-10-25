import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../../src/db/index.js';
import { seedDefaults } from '../../src/db/adminConfigRepo.js';
import { upsertPerson, getPersonById, setFerienmodus, deactivatePerson } from '../../src/db/personenRepo.js';
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
  await r.zustellung;
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
  await r2.zustellung;
  assert.deepEqual(mailer.sent.map((m) => m.to), ['p3@example.org']);
  assert.deepEqual(listeKommentare(db, jobId).map((k) => k.text), ['Ist das @Anna Beispiel recht?\nZweite Zeile', 'Ja, passt.']);
  db.close();
});

test('erfasseKommentar: Admin ohne Rolle nur bei Erwähnung', async () => {
  const { db, job, p } = setup();
  const mailer = stubMailer();
  await (await erfasseKommentar(db, CONFIG, mailer, { job: job(), person: p('1'), text: 'Ohne Erwähnung' })).zustellung;
  assert.ok(!mailer.sent.some((m) => m.to === 'p6@example.org' || m.to === 'p7@example.org'));
  mailer.sent.length = 0;
  await (await erfasseKommentar(db, CONFIG, mailer, { job: job(), person: p('1'), text: '@Fritz Admin bitte schauen' })).zustellung;
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
  const lang = await erfasseKommentar(db, CONFIG, mailer, { job: job(), person: p('1'), text: 'a'.repeat(2000) });
  assert.equal(lang.ok, true);
  await lang.zustellung;
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
  await (await erfasseKommentar(db, CONFIG, mailer, { job: job(), person: p('3'), text: 'Eins', jetzt: new Date('2026-10-25T08:00:00.000Z') })).zustellung;
  await (await erfasseKommentar(db, CONFIG, mailer, { job: job(), person: p('1'), text: 'Zwei', jetzt: new Date('2026-10-25T08:01:00.000Z') })).zustellung;
  let info = kommentarInfo(db, [jobId, andererId], '1');
  assert.deepEqual(info.get(jobId), { anzahl: 2, neu: 1 });
  assert.equal(info.has(andererId), false);
  markiereGelesen(db, jobId, '1', new Date('2026-10-25T08:02:00.000Z'));
  assert.deepEqual(kommentarInfo(db, [jobId], '1').get(jobId), { anzahl: 2, neu: 0 });
  await (await erfasseKommentar(db, CONFIG, mailer, { job: job(), person: p('3'), text: 'Drei', jetzt: new Date('2026-10-25T08:03:00.000Z') })).zustellung;
  assert.deepEqual(kommentarInfo(db, [jobId], '1').get(jobId), { anzahl: 3, neu: 1 });
  markiereGelesen(db, jobId, '1', new Date('2026-10-25T08:04:00.000Z'));
  assert.deepEqual(kommentarInfo(db, [jobId], '1').get(jobId), { anzahl: 3, neu: 0 });
  assert.deepEqual(kommentarInfo(db, [jobId], '3').get(jobId), { anzahl: 3, neu: 1 });
  assert.equal(kommentarInfo(db, [], '1').size, 0);
  db.close();
});

// --- Fix-Runde 1 ---

function weitere(db, eintraege) {
  for (const [id, vorname, nachname, gruppen] of eintraege) {
    upsertPerson(db, { id, vorname, nachname, email: `p${id}@example.org`, gruppen, loggedInNow: true });
  }
}

async function kommentiere(db, mailer, job, person, text) {
  const r = await erfasseKommentar(db, CONFIG, mailer, { job, person, text });
  assert.equal(r.ok, true, JSON.stringify(r.fehler));
  await r.zustellung;
  return r;
}

const mailAn = (mailer, id) => mailer.sent.filter((m) => m.to === `p${id}@example.org`);

test('freigabe2 mit Stellvertretung als Freigeber 1: Rückfrage von F2 erreicht die Person, die kontiert hat', async () => {
  const { db, jobId, job, p } = setup();
  db.prepare("UPDATE jobs SET zugewiesen_an = '2', status = 'freigabe2' WHERE id = ?").run(jobId);
  assert.deepEqual(beteiligte(db, CONFIG, job(), { schreiberId: '3' }), ['2']);
  const mailer = stubMailer();
  await kommentiere(db, mailer, job(), p('3'), 'Warum dieses Konto?');
  assert.deepEqual(mailer.sent.map((m) => m.to), ['p2@example.org']);
  assert.match(mailer.sent[0].text, new RegExp(`/zeitstempel-pruefen\\?jobId=${jobId}#kommentare`));
  // Antwort von 2: F2 ist jetzt zuständig und bekommt die Freigabe-2-Seite.
  mailer.sent.length = 0;
  await kommentiere(db, mailer, job(), p('2'), 'Weil Unterhalt.');
  assert.deepEqual(mailer.sent.map((m) => m.to), ['p3@example.org']);
  assert.match(mailer.sent[0].text, new RegExp(`/freigabe2/${jobId}#kommentare`));
  db.close();
});

test('Links je Empfänger: zuständig, nur Vorgänge-Recht, sonst Zeitstempel-Prüfseite', async () => {
  const { db, jobId, job, p } = setup();
  setFerienmodus(db, '1', { von: '2000-01-01', bis: '2999-01-01', stellvertreterId: '8' });
  const mailer = stubMailer();
  await kommentiere(db, mailer, job(), p('6'), '@Gina Einsicht und @Clara Zwei, bitte ansehen');
  const link = (id) => mailAn(mailer, id).map((m) => m.text.match(/https:\/\/\S+/)[0]);
  assert.deepEqual(link('1'), [`https://portal.example.org/kontierung/${jobId}#kommentare`]);
  assert.deepEqual(link('8'), [`https://portal.example.org/kontierung/${jobId}#kommentare`], 'Vertretung der zuständigen Person');
  assert.deepEqual(link('3'), [`https://portal.example.org/zeitstempel-pruefen?jobId=${jobId}#kommentare`], 'F2 vor seiner Phase');
  assert.deepEqual(link('7'), [`https://portal.example.org/admin/vorgaenge/${jobId}#kommentare`], 'nur Vorgänge-Recht');
  assert.equal(mailAn(mailer, '6').length, 0, 'nie an den Schreiber');
  for (const id of ['1', '8', '3', '7']) assert.equal(mailAn(mailer, id).length, 1, `genau eine Mail an ${id}`);
  db.close();
});

test('Links Spesen: Prüfperson auf spesen-freigabe1, Einreicherin auf die Zeitstempel-Prüfseite', async () => {
  const { db, p } = setup();
  const spesenId = createJob(db, { eingangAm: '2026-10-20T08:00:00.000Z', quelle: 'spesen', absender: null, dateiname: 's.pdf', pdfPfad: '/tmp/s.pdf' });
  db.prepare("UPDATE jobs SET eingereicht_von = '9', status = 'zugewiesen', zugewiesen_an = '1' WHERE id = ?").run(spesenId);
  const mailer = stubMailer();
  await kommentiere(db, mailer, getJobById(db, spesenId), p('9'), 'Beleg ist nachgereicht.');
  assert.match(mailAn(mailer, '1')[0].text, new RegExp(`/spesen-freigabe1/${spesenId}#kommentare`));
  mailer.sent.length = 0;
  await kommentiere(db, mailer, getJobById(db, spesenId), p('1'), 'Danke.');
  assert.match(mailAn(mailer, '9')[0].text, new RegExp(`/zeitstempel-pruefen\\?jobId=${spesenId}#kommentare`));
  db.close();
});

test('Eskalation an die Admins: Admin-Gruppe gilt als zuständig und wird ohne Erwähnung benachrichtigt', async () => {
  const { db, jobId, job, p } = setup();
  db.prepare("UPDATE jobs SET status = 'freigabe2', freigabe2_eskaliert_an_admin = 1 WHERE id = ?").run(jobId);
  const mailer = stubMailer();
  await kommentiere(db, mailer, job(), p('1'), 'Ist die Eskalation angekommen?');
  assert.equal(mailAn(mailer, '6').length, 1);
  assert.match(mailAn(mailer, '6')[0].text, new RegExp(`/freigabe2/${jobId}#kommentare`));
  assert.equal(mailAn(mailer, '7').length, 0, 'Vorgänge-Recht allein macht nicht zuständig');
  db.close();
});

test('Manager ohne ausdrückliches vorgaenge_einsehen sieht und kommentiert', async () => {
  const { db, job, jobId, p } = setup();
  weitere(db, [['11', 'Mia', 'Manager', ['30']]]);
  assert.equal(darfKommentareSehen(db, CONFIG, p('11'), job()), true);
  assert.equal(darfKommentieren(db, CONFIG, p('11'), job()), true);
  assert.ok(erwaehnbarePersonen(db, CONFIG, job()).some((x) => x.id === '11'));
  const mailer = stubMailer();
  await kommentiere(db, mailer, job(), p('1'), '@Mia Manager kurz drüberschauen');
  assert.match(mailAn(mailer, '11')[0].text, new RegExp(`/admin/vorgaenge/${jobId}#kommentare`));
  db.close();
});

test('Gleichnamige Kandidaten: sichtbare Person gilt als gemeint, längerer unsichtbarer Name wird gemeldet', async () => {
  const { db, job, p } = setup();
  weitere(db, [['12', 'Anna', 'Beispiel', []], ['13', 'Hans Peter', 'Muster', []], ['14', 'Hans', 'Peter', []]]);
  setBerechtigungenForPerson(db, '14', ['vorgaenge_einsehen']);
  assert.deepEqual(findeErwaehnungen('@Anna Beispiel', [{ id: '1', name: 'Anna Beispiel' }, { id: '12', name: 'Anna Beispiel' }]).ids, ['1', '12']);
  const mailer = stubMailer();
  const r = await kommentiere(db, mailer, job(), p('3'), '@Anna Beispiel bitte');
  assert.deepEqual(JSON.parse(db.prepare('SELECT erwaehnt FROM kommentare WHERE id = ?').get(r.id).erwaehnt), ['1']);
  assert.equal(mailAn(mailer, '12').length, 0);
  const kollision = await erfasseKommentar(db, CONFIG, mailer, { job: job(), person: p('3'), text: '@Hans Peter Muster bitte prüfen' });
  assert.equal(kollision.ok, false);
  assert.match(kollision.fehler.join(' '), /Hans Peter Muster darf diesen Vorgang nicht sehen/);
  const kurz = await erfasseKommentar(db, CONFIG, mailer, { job: job(), person: p('3'), text: '@Hans Peter bitte prüfen' });
  assert.equal(kurz.ok, true);
  await kurz.zustellung;
  db.close();
});

test('Inaktive Personen: sehen nichts und bekommen keine Mail', async () => {
  const { db, job, p } = setup();
  deactivatePerson(db, '3');
  assert.equal(darfKommentareSehen(db, CONFIG, p('3'), job()), false);
  assert.ok(!erwaehnbarePersonen(db, CONFIG, job()).some((x) => x.id === '3'));
  const mailer = stubMailer();
  await kommentiere(db, mailer, job(), p('1'), 'Hallo zusammen');
  assert.equal(mailAn(mailer, '3').length, 0);
  const erwaehnt = await erfasseKommentar(db, CONFIG, mailer, { job: job(), person: p('1'), text: '@Clara Zwei?' });
  assert.equal(erwaehnt.ok, false);
  db.close();
});

test('Erwähnungen: NFD, NBSP, Zeilenumbruch, mehrfacher Leerraum, Längenänderung beim Kleinschreiben', () => {
  const k = [{ id: '20', name: 'Jürg Müller' }, { id: '21', name: 'Clara Zwei' }];
  assert.deepEqual(findeErwaehnungen('@Jürg Müller bitte', k).ids, ['20']);
  assert.deepEqual(findeErwaehnungen('@Jürg Müller', k).ids, ['20']);
  assert.deepEqual(findeErwaehnungen('@Jürg\nMüller', k).ids, ['20']);
  assert.deepEqual(findeErwaehnungen('@jürg   MÜLLER.', k).ids, ['20']);
  assert.deepEqual(findeErwaehnungen('İİİ @Clara Zwei', k), { ids: ['21'], unbekannt: [] });
  assert.deepEqual(findeErwaehnungen('@Jürg', k), { ids: [], unbekannt: ['Jürg'] });
});

test('Kommentar und Mails in einer Transaktion: scheitert das Einreihen, bleibt nichts gespeichert', async () => {
  const { db, jobId, job, p } = setup();
  db.exec("CREATE TEMP TRIGGER mail_log_kaputt BEFORE INSERT ON mail_log BEGIN SELECT RAISE(ABORT, 'Platte voll'); END");
  await assert.rejects(erfasseKommentar(db, CONFIG, stubMailer(), { job: job(), person: p('3'), text: 'Hallo' }), /Platte voll/);
  assert.equal(listeKommentare(db, jobId).length, 0);
  db.exec('DROP TRIGGER mail_log_kaputt');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM mail_log WHERE typ = 'kommentar'").get().n, 0);
  assert.equal(db.isTransaction, false);
  db.close();
});

test('Ruling 2: gelöschte Vorlage kommentar → Rückfall auf die Werkseinstellung, Kommentar und Mail bleiben', async () => {
  const { db, jobId, job, p } = setup();
  db.prepare("DELETE FROM admin_config WHERE key IN ('mail_vorlage_kommentar_text', 'mail_vorlage_kommentar_betreff')").run();
  const mailer = stubMailer();
  const r = await erfasseKommentar(db, CONFIG, mailer, { job: job(), person: p('3'), text: 'Hallo' });
  assert.equal(r.ok, true);
  await r.zustellung;
  assert.equal(listeKommentare(db, jobId).length, 1);
  const zeilen = db.prepare("SELECT betreff, text FROM mail_log WHERE typ = 'kommentar'").all();
  assert.ok(zeilen.length > 0);
  assert.match(zeilen[0].betreff, /Neuer Kommentar zu rechnung\.pdf/);
  assert.match(zeilen[0].text, /Clara Zwei hat einen Kommentar/);
  db.close();
});

test('Ruling 2: Rendern scheitert trotz Rückfall → Kommentar bleibt, Fehler geloggt, Mail als fehlgeschlagen erfasst', async () => {
  const { db, jobId, job, p } = setup();
  const kaputt = { ...job(), dateiname: { toString() { throw new Error('Vorlage kaputt'); } } };
  const fehler = [];
  const original = console.error;
  console.error = (...args) => fehler.push(args);
  let r;
  try {
    r = await erfasseKommentar(db, CONFIG, stubMailer(), { job: kaputt, person: p('3'), text: 'Hallo' });
    await r.zustellung;
  } finally {
    console.error = original;
  }
  assert.equal(r.ok, true);
  assert.equal(listeKommentare(db, jobId).length, 1);
  assert.ok(fehler.some((a) => String(a[0]).includes('Vorlage konnte nicht gerendert werden')));
  const zeilen = db.prepare("SELECT status, fehler_details FROM mail_log WHERE typ = 'kommentar'").all();
  assert.ok(zeilen.length > 0);
  assert.ok(zeilen.every((z) => z.status === 'fehlgeschlagen' && /Vorlage kaputt/.test(z.fehler_details)));
  db.close();
});

test('N2: scheitert ROLLBACK TO, wird der ursprüngliche Fehler geworfen', async () => {
  const { db, job, p } = setup();
  db.exec("CREATE TEMP TRIGGER mail_log_kaputt BEFORE INSERT ON mail_log BEGIN SELECT RAISE(ABORT, 'Platte voll'); END");
  const exec = db.exec.bind(db);
  db.exec = (sql) => {
    if (String(sql).startsWith('ROLLBACK TO')) throw new Error('Rollback kaputt');
    return exec(sql);
  };
  const original = console.error;
  console.error = () => {};
  try {
    await assert.rejects(erfasseKommentar(db, CONFIG, stubMailer(), { job: job(), person: p('3'), text: 'Hallo' }), /Platte voll/);
  } finally {
    console.error = original;
    db.exec = exec;
  }
  try { exec('ROLLBACK'); } catch { /* evtl. keine offene Transaktion */ }
  db.close();
});

test('SMTP-Fehler: Kommentar gespeichert, Mail bleibt zur Wiederholung eingereiht', async () => {
  const { db, jobId, job, p } = setup();
  const mailer = { async sendMail() { throw new Error('SMTP down'); } };
  const r = await erfasseKommentar(db, CONFIG, mailer, { job: job(), person: p('3'), text: 'Hallo' });
  assert.equal(r.ok, true);
  await r.zustellung;
  assert.equal(listeKommentare(db, jobId).length, 1);
  const zeilen = db.prepare("SELECT status FROM mail_log WHERE typ = 'kommentar'").all();
  assert.equal(zeilen.length, 1);
  assert.notEqual(zeilen[0].status, 'versendet');
  db.close();
});

test('Sichtbarkeits-Prädikat (vorgeladen) = darfKommentareSehen je Person, über Status, Vertretung, Rollen und Rechte', () => {
  const { db, jobId, job, p } = setup();
  upsertPerson(db, { id: '11', vorname: 'Mia', nachname: 'Manager', email: 'p11@example.org', gruppen: ['30'], loggedInNow: true });
  upsertPerson(db, { id: '12', vorname: 'Bea', nachname: 'Buch', email: 'p12@example.org', gruppen: ['10'], loggedInNow: true });
  setFerienmodus(db, '1', { von: '2000-01-01', bis: '2999-01-01', stellvertreterId: '8' });
  setFerienmodus(db, '3', { von: '2000-01-01', bis: '2999-01-01', stellvertreterId: '2' });
  db.prepare("UPDATE jobs SET eingereicht_von = '9' WHERE id = ?").run(jobId);
  const ids = db.prepare('SELECT churchtools_person_id AS id FROM personen WHERE aktiv = 1').all().map((r) => r.id);
  const varianten = [
    {},
    { status: 'freigabe2' },
    { status: 'freigabe2', freigabe2_eskaliert_von: '3' },
    { status: 'freigabe2', freigabe2_umgeleitet_an: '5' },
    { status: 'unzugewiesen', zugewiesen_an: null },
    { status: 'abgeschlossen' },
    { konto_id: null },
  ];
  for (const v of varianten) {
    const j = { ...job(), ...v };
    const erwartet = ids.filter((id) => darfKommentareSehen(db, CONFIG, p(id), j)).sort();
    const ist = erwaehnbarePersonen(db, CONFIG, j).map((e) => e.id).sort();
    assert.deepEqual(ist, erwartet, JSON.stringify(v));
  }
  db.close();
});
