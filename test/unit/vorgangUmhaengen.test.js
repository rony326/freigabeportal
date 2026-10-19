import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson, setFerienmodus } from '../../src/db/personenRepo.js';
import { createKonto } from '../../src/db/kontenRepo.js';
import { seedDefaults } from '../../src/db/adminConfigRepo.js';
import { createFreigabe, listFreigabenByJob } from '../../src/db/freigabenRepo.js';
import { listMailLog } from '../../src/db/mailLogRepo.js';
import { createJob, getJobById } from '../../src/db/jobsRepo.js';
import { ermittleZustaendigkeit, standToken } from '../../src/services/vorgangZustaendigkeit.js';
import { listUmhaengenZiele, umhaengeVorgang } from '../../src/services/vorgangUmhaengen.js';

const CONFIG = { publicBaseUrl: 'https://portal.example.org', churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20' } };
const MAILER = { async sendMail() {} };

function seed(db) {
  seedDefaults(db);
  for (const id of ['1', '2', '3', '4', '5', '6', '7']) {
    upsertPerson(db, { id, vorname: `P${id}`, nachname: 'M', email: `p${id}@example.org`, gruppen: [], loggedInNow: false });
  }
  upsertPerson(db, { id: '99', vorname: 'Ad', nachname: 'Min', email: 'admin@example.org', gruppen: ['20'], loggedInNow: false });
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'U', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  // Zweites Konto, damit 5, 6 und 7 eine Konto-Rolle haben und als Ziel wählbar sind.
  createKonto(db, { kontonummer: '4000', bezeichnung: 'V', freigeber1Id: '5', stellvertreter1Id: '6', freigeber2Id: '7', stellvertreter2Id: '1' });
  return kontoId;
}

function neuerJob(db, { status, kontoId = null, zugewiesenAn = null, quelle = 'scanner', extra = {} }) {
  const jobId = createJob(db, { eingangAm: '2026-10-01T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare('UPDATE jobs SET status = ?, konto_id = ?, zugewiesen_an = ?, quelle = ? WHERE id = ?').run(status, kontoId, zugewiesenAn, quelle, jobId);
  for (const [spalte, wert] of Object.entries(extra)) db.prepare(`UPDATE jobs SET ${spalte} = ? WHERE id = ?`).run(wert, jobId);
  return jobId;
}

function admin(db) {
  return db.prepare("SELECT * FROM personen WHERE churchtools_person_id = '99'").get();
}

async function haenge(db, jobId, zielId, bemerkung = 'Urlaubsvertretung geklärt') {
  const job = getJobById(db, jobId);
  return umhaengeVorgang(db, CONFIG, MAILER, {
    jobId, zielId, bemerkung, standErwartet: standToken(job, ermittleZustaendigkeit(db, job)),
    admin: { ...admin(db), gruppen: ['20'] }, ip: '127.0.0.1',
  });
}

test('ermittleZustaendigkeit: Pool, Person, Admin-Gruppe, Freigabe 2 mit Umleitung', () => {
  const db = openDatabase(':memory:');
  const kontoId = seed(db);
  assert.deepEqual(ermittleZustaendigkeit(db, getJobById(db, neuerJob(db, { status: 'unzugewiesen' }))), { art: 'pool', personId: null });
  assert.deepEqual(ermittleZustaendigkeit(db, getJobById(db, neuerJob(db, { status: 'zugewiesen', zugewiesenAn: '1' }))), { art: 'person', personId: '1' });
  assert.deepEqual(ermittleZustaendigkeit(db, getJobById(db, neuerJob(db, { status: 'zugewiesen', zugewiesenAn: '1', extra: { freigabe1_eskaliert_an_admin: 1 } }))), { art: 'admin', personId: null });
  assert.deepEqual(ermittleZustaendigkeit(db, getJobById(db, neuerJob(db, { status: 'freigabe2', kontoId, extra: { freigabe2_umgeleitet_an: '5' } }))), { art: 'person', personId: '5' });
  db.close();
});

test('Pool → zugewiesen an Zielperson, Verlaufseintrag und Mail', async () => {
  const db = openDatabase(':memory:');
  seed(db);
  const jobId = neuerJob(db, { status: 'unzugewiesen', extra: { pool_rueckgesendet_bemerkung: 'falsch', pool_rueckgesendet_von: '1', pool_rueckgesendet_am: '2026-10-01' } });
  assert.deepEqual(await haenge(db, jobId, '5'), { ok: true });
  const job = getJobById(db, jobId);
  assert.equal(job.status, 'zugewiesen');
  assert.equal(job.zugewiesen_an, '5');
  assert.equal(job.pool_rueckgesendet_bemerkung, null);
  const eintrag = listFreigabenByJob(db, jobId).at(-1);
  assert.equal(eintrag.rolle, 'admin_umzuweisung');
  assert.equal(eintrag.person_id, '99');
  assert.equal(eintrag.ziel_person_id, '5');
  assert.equal(eintrag.vorher_zustaendig, null);
  assert.match(eintrag.kommentar, /Von Pool an P5 M: Urlaubsvertretung geklärt/);
  const mails = listMailLog(db).filter((m) => m.typ === 'admin-umzuweisung');
  assert.deepEqual(mails.map((m) => m.empfaenger), ['p5@example.org']);
  assert.match(mails[0].text, /\/kontierung\//);
  db.close();
});

test('zugewiesen → neue Person, Admin-Eskalation aufgehoben, Info-Mail an bisherige Person', async () => {
  const db = openDatabase(':memory:');
  const kontoId = seed(db);
  const jobId = neuerJob(db, { status: 'zugewiesen', kontoId, zugewiesenAn: '1' });
  assert.deepEqual(await haenge(db, jobId, '5'), { ok: true });
  assert.equal(getJobById(db, jobId).zugewiesen_an, '5');
  assert.equal(getJobById(db, jobId).konto_id, kontoId);
  assert.equal(listFreigabenByJob(db, jobId).at(-1).vorher_zustaendig, '1');
  const empfaenger = listMailLog(db).filter((m) => m.typ === 'admin-umzuweisung').map((m) => m.empfaenger).sort();
  assert.deepEqual(empfaenger, ['p1@example.org', 'p5@example.org']);
  db.close();
});

test('freigabe2 → Umleitung gesetzt, Admin-Eskalation zurückgesetzt, Uhr neu gestartet', async () => {
  const db = openDatabase(':memory:');
  const kontoId = seed(db);
  const jobId = neuerJob(db, { status: 'freigabe2', kontoId, zugewiesenAn: '1', extra: { freigabe2_eskaliert_an_admin: 1, freigabe2_seit: '2020-01-01T00:00:00.000Z', freigabe2_reminder_gesendet_at: '2020-01-02T00:00:00.000Z' } });
  createFreigabe(db, { jobId, personId: '1', rolle: 'freigeber1', zeitpunkt: '2026-10-01T09:00:00.000Z', ip: '1.2.3.4', interessenskonflikt: false, kommentar: null, eskaliertVon: null });
  assert.deepEqual(await haenge(db, jobId, '5'), { ok: true });
  const job = getJobById(db, jobId);
  assert.equal(job.freigabe2_umgeleitet_an, '5');
  assert.equal(job.freigabe2_eskaliert_an_admin, 0);
  assert.equal(job.freigabe2_reminder_gesendet_at, null);
  assert.ok(job.freigabe2_seit > '2026-01-01');
  db.close();
});

test('abgelehnt → zugewiesen_an neu; abgelehnte Spesen sind nicht umhängbar', async () => {
  const db = openDatabase(':memory:');
  const kontoId = seed(db);
  const jobId = neuerJob(db, { status: 'abgelehnt', kontoId, zugewiesenAn: '1' });
  assert.deepEqual(await haenge(db, jobId, '5'), { ok: true });
  assert.equal(getJobById(db, jobId).zugewiesen_an, '5');
  const spesenId = neuerJob(db, { status: 'abgelehnt', kontoId, zugewiesenAn: '1', quelle: 'spesen', extra: { eingereicht_von: '6' } });
  assert.deepEqual(await haenge(db, spesenId, '5'), { fehler: 'phase' });
  db.close();
});

test('Ausschlüsse bei Freigabe 2: Freigabe-1-Person, alle F2-Konfliktmelder, Spesen-Einreicher, aktuell Zuständige', () => {
  const db = openDatabase(':memory:');
  const kontoId = seed(db);
  // Freigeber 2 (3) meldete Konflikt, danach Stellvertreter 2 (4) ebenfalls -> freigabe2_eskaliert_von zeigt nur noch auf 4.
  const jobId = neuerJob(db, { status: 'freigabe2', kontoId, zugewiesenAn: '1', quelle: 'spesen', extra: { eingereicht_von: '6', freigabe2_eskaliert_von: '4', freigabe2_eskaliert_an_admin: 1 } });
  createFreigabe(db, { jobId, personId: '2', rolle: 'freigeber1', zeitpunkt: '2026-10-01T09:00:00.000Z', ip: '1', interessenskonflikt: false, kommentar: null, eskaliertVon: null });
  createFreigabe(db, { jobId, personId: '3', rolle: 'freigabe2_eskalation', zeitpunkt: '2026-10-01T10:00:00.000Z', ip: '1', interessenskonflikt: true, kommentar: 'x', eskaliertVon: null });
  createFreigabe(db, { jobId, personId: '4', rolle: 'freigabe2_eskalation', zeitpunkt: '2026-10-01T11:00:00.000Z', ip: '1', interessenskonflikt: true, kommentar: 'y', eskaliertVon: '3' });
  const ziele = listUmhaengenZiele(db, getJobById(db, jobId)).map((p) => p.churchtools_person_id).sort();
  assert.deepEqual(ziele, ['1', '5', '7']);
  db.close();
});

test('Ausschluss bei Kontierung: wer bei Freigabe 1 einen Konflikt erklärt hat', () => {
  const db = openDatabase(':memory:');
  const kontoId = seed(db);
  const jobId = neuerJob(db, { status: 'zugewiesen', kontoId, zugewiesenAn: '2', extra: { freigabe1_eskaliert_von: '1' } });
  createFreigabe(db, { jobId, personId: '1', rolle: 'freigabe1_eskalation', zeitpunkt: '2026-10-01T09:00:00.000Z', ip: '1', interessenskonflikt: true, kommentar: 'x', eskaliertVon: null });
  const ziele = listUmhaengenZiele(db, getJobById(db, jobId)).map((p) => p.churchtools_person_id);
  assert.ok(!ziele.includes('1'));
  assert.ok(!ziele.includes('2'));
  assert.ok(ziele.includes('3'));
  db.close();
});

test('nicht erlaubtes Ziel wird abgewiesen, nichts geschrieben', async () => {
  const db = openDatabase(':memory:');
  const kontoId = seed(db);
  const jobId = neuerJob(db, { status: 'freigabe2', kontoId, zugewiesenAn: '1' });
  createFreigabe(db, { jobId, personId: '1', rolle: 'freigeber1', zeitpunkt: '2026-10-01T09:00:00.000Z', ip: '1', interessenskonflikt: false, kommentar: null, eskaliertVon: null });
  assert.deepEqual(await haenge(db, jobId, '1'), { fehler: 'ziel' });
  assert.equal(getJobById(db, jobId).freigabe2_umgeleitet_an, null);
  assert.equal(listFreigabenByJob(db, jobId).length, 1);
  db.close();
});

test('veralteter Stand (inzwischen Freigabe 2 erteilt) → fehler stand, nichts geschrieben, keine Mail', async () => {
  const db = openDatabase(':memory:');
  const kontoId = seed(db);
  const jobId = neuerJob(db, { status: 'freigabe2', kontoId, zugewiesenAn: '1' });
  const job = getJobById(db, jobId);
  const standErwartet = standToken(job, ermittleZustaendigkeit(db, job));
  db.prepare("UPDATE jobs SET status = 'abgeschlossen' WHERE id = ?").run(jobId);
  const ergebnis = await umhaengeVorgang(db, CONFIG, MAILER, { jobId, zielId: '5', bemerkung: 'Urlaubsvertretung geklärt', standErwartet, admin: admin(db), ip: '1' });
  assert.deepEqual(ergebnis, { fehler: 'phase' });
  // Gleicher Status, aber andere zuständige Person:
  db.prepare("UPDATE jobs SET status = 'freigabe2', freigabe2_eskaliert_von = '3' WHERE id = ?").run(jobId);
  const ergebnis2 = await umhaengeVorgang(db, CONFIG, MAILER, { jobId, zielId: '5', bemerkung: 'Urlaubsvertretung geklärt', standErwartet, admin: admin(db), ip: '1' });
  assert.deepEqual(ergebnis2, { fehler: 'stand' });
  assert.equal(getJobById(db, jobId).freigabe2_umgeleitet_an, null);
  assert.equal(listMailLog(db).filter((m) => m.typ === 'admin-umzuweisung').length, 0);
  db.close();
});

test('Zielperson im Ferienmodus: Mail auch an die Vertretung', async () => {
  const db = openDatabase(':memory:');
  seed(db);
  const heute = new Date().toISOString().slice(0, 10);
  setFerienmodus(db, '5', { von: heute, bis: heute, stellvertreterId: '6' });
  const jobId = neuerJob(db, { status: 'unzugewiesen' });
  await haenge(db, jobId, '5');
  const empfaenger = listMailLog(db).filter((m) => m.typ === 'admin-umzuweisung').map((m) => m.empfaenger).sort();
  assert.deepEqual(empfaenger, ['p5@example.org', 'p6@example.org']);
  db.close();
});
