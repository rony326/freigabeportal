import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson, setFerienmodus, deactivatePerson } from '../../src/db/personenRepo.js';
import { createKonto, getKontoById } from '../../src/db/kontenRepo.js';
import { seedDefaults, setConfigValue } from '../../src/db/adminConfigRepo.js';
import { listMailLog } from '../../src/db/mailLogRepo.js';
import {
  createJob, getJobById, getEffectiveFreigeber2Id, EFFEKTIVER_FREIGEBER2_SQL,
  listFreigabe2JobsForPerson, listStalledJobs,
} from '../../src/db/jobsRepo.js';
import { runFreigabe2ErinnerungenJob } from '../../src/services/cronJobs.js';

const CONFIG = { publicBaseUrl: 'https://portal.example.org', churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20' } };

function seed(db) {
  for (const id of ['1', '2', '3', '4', '5', '6']) {
    upsertPerson(db, { id, vorname: `P${id}`, nachname: 'M', email: `p${id}@example.org`, gruppen: [], loggedInNow: false });
  }
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'U', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  const jobId = createJob(db, { eingangAm: '2026-10-01T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare("UPDATE jobs SET status = 'freigabe2', konto_id = ?, zugewiesen_an = '1', freigabe2_seit = ? WHERE id = ?").run(kontoId, new Date().toISOString(), jobId);
  return { kontoId, jobId };
}

function sqlWert(db, jobId) {
  return db.prepare(`SELECT ${EFFEKTIVER_FREIGEBER2_SQL} AS id FROM jobs JOIN konten ON konten.id = jobs.konto_id WHERE jobs.id = ?`).get(jobId).id;
}

test('JS-Funktion und SQL-Fragment liefern für alle Fälle dieselbe Person', () => {
  const db = openDatabase(':memory:');
  const { kontoId, jobId } = seed(db);
  const faelle = [
    { setze: { freigabe2_eskaliert_von: null, freigabe2_umgeleitet_an: null }, erwartet: '3' },
    { setze: { freigabe2_eskaliert_von: '3', freigabe2_umgeleitet_an: null }, erwartet: '4' },
    { setze: { freigabe2_eskaliert_von: null, freigabe2_umgeleitet_an: '5' }, erwartet: '5' },
    { setze: { freigabe2_eskaliert_von: '3', freigabe2_umgeleitet_an: '5' }, erwartet: '5' },
  ];
  for (const { setze, erwartet } of faelle) {
    db.prepare('UPDATE jobs SET freigabe2_eskaliert_von = ?, freigabe2_umgeleitet_an = ? WHERE id = ?').run(setze.freigabe2_eskaliert_von, setze.freigabe2_umgeleitet_an, jobId);
    const job = getJobById(db, jobId);
    assert.equal(getEffectiveFreigeber2Id(job, getKontoById(db, kontoId)), erwartet, JSON.stringify(setze));
    assert.equal(sqlWert(db, jobId), erwartet, `SQL ${JSON.stringify(setze)}`);
  }
  db.close();
});

test('Aufgabenliste: umgeleitete Person und ihre Ferienvertretung sehen den Job, der ursprüngliche Freigeber 2 nicht', () => {
  const db = openDatabase(':memory:');
  const { jobId } = seed(db);
  db.prepare("UPDATE jobs SET freigabe2_umgeleitet_an = '5' WHERE id = ?").run(jobId);
  const heute = new Date().toISOString().slice(0, 10);
  setFerienmodus(db, '5', { von: heute, bis: heute, stellvertreterId: '6' });
  assert.deepEqual(listFreigabe2JobsForPerson(db, '5').map((j) => j.id), [jobId]);
  assert.deepEqual(listFreigabe2JobsForPerson(db, '6').map((j) => j.id), [jobId]);
  assert.deepEqual(listFreigabe2JobsForPerson(db, '3'), []);
  db.close();
});

test('listStalledJobs meldet eine deaktivierte umgeleitete Person', () => {
  const db = openDatabase(':memory:');
  const { jobId } = seed(db);
  db.prepare("UPDATE jobs SET freigabe2_umgeleitet_an = '5' WHERE id = ?").run(jobId);
  deactivatePerson(db, '5', 'churchtools_geloescht');
  const stalled = listStalledJobs(db).find((s) => s.job.id === jobId);
  assert.ok(stalled);
  assert.equal(stalled.akteurId, '5');
  db.close();
});

test('freigabe2-erinnerungen schickt den Reminder an die umgeleitete Person', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  setConfigValue(db, 'freigabe2_reminder_stunden', '24');
  setConfigValue(db, 'freigabe2_eskalation_stunden', '1000');
  const { jobId } = seed(db);
  const vor30h = new Date(Date.now() - 30 * 3600 * 1000).toISOString();
  db.prepare("UPDATE jobs SET freigabe2_umgeleitet_an = '5', freigabe2_seit = ? WHERE id = ?").run(vor30h, jobId);
  const mailer = { async sendMail() {} };
  await runFreigabe2ErinnerungenJob(db, CONFIG, mailer);
  const reminder = listMailLog(db).filter((m) => m.typ === 'freigabe2-reminder');
  assert.deepEqual(reminder.map((m) => m.empfaenger), ['p5@example.org']);
  db.close();
});
