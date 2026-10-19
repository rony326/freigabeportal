import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson, deactivatePerson } from '../../src/db/personenRepo.js';
import { createKonto } from '../../src/db/kontenRepo.js';
import { createKreditor } from '../../src/db/kreditorenRepo.js';
import { seedDefaults } from '../../src/db/adminConfigRepo.js';
import { createFreigabe } from '../../src/db/freigabenRepo.js';
import { createJob } from '../../src/db/jobsRepo.js';
import { listLaufendeVorgaenge } from '../../src/services/vorgaengeUebersicht.js';

function seed(db) {
  seedDefaults(db);
  for (const id of ['1', '2', '3', '4', '5', '6', '7', '8']) {
    upsertPerson(db, { id, vorname: `P${id}`, nachname: 'M', email: `p${id}@example.org`, gruppen: [], loggedInNow: false });
  }
  const kontoA = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  const kontoB = createKonto(db, { kontonummer: '4000', bezeichnung: 'Jugend', freigeber1Id: '5', stellvertreter1Id: '6', freigeber2Id: '7', stellvertreter2Id: '8' });
  return { kontoA, kontoB };
}

function job(db, felder) {
  const id = createJob(db, { eingangAm: felder.eingang_am ?? '2026-10-01T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: `${felder.name}.pdf`, pdfPfad: '/tmp/x.pdf' });
  for (const [spalte, wert] of Object.entries(felder)) {
    if (spalte === 'name' || spalte === 'eingang_am') continue;
    db.prepare(`UPDATE jobs SET ${spalte} = ? WHERE id = ?`).run(wert, id);
  }
  return id;
}

test('listet nur laufende Status, älteste zuerst', () => {
  const db = openDatabase(':memory:');
  const { kontoA } = seed(db);
  job(db, { name: 'neu', status: 'unzugewiesen', eingang_am: '2026-10-05T08:00:00.000Z' });
  job(db, { name: 'alt', status: 'zugewiesen', zugewiesen_an: '1', konto_id: kontoA, eingang_am: '2026-09-01T08:00:00.000Z' });
  job(db, { name: 'fertig', status: 'abgeschlossen', konto_id: kontoA });
  job(db, { name: 'eltern', status: 'aufgesplittet' });
  job(db, { name: 'weg', status: 'geloescht' });
  assert.deepEqual(listLaufendeVorgaenge(db).map((v) => v.dateiname), ['alt.pdf', 'neu.pdf']);
  db.close();
});

test('Zuständigkeit und Prognose Freigabe 2: Konto, Kreditor-Default, Hinweis-Konto, offen, Stellvertreter 2 nach Konflikt', () => {
  const db = openDatabase(':memory:');
  const { kontoA, kontoB } = seed(db);
  const kreditorId = createKreditor(db, { name: 'Muster AG', kontoId: kontoB });
  job(db, { name: 'konto', status: 'zugewiesen', zugewiesen_an: '1', konto_id: kontoA });
  job(db, { name: 'kreditor', status: 'zugewiesen', zugewiesen_an: '1', kreditor_id: kreditorId });
  job(db, { name: 'hinweis', status: 'unzugewiesen', hinweis_konto_id: kontoA });
  job(db, { name: 'offen', status: 'unzugewiesen' });
  job(db, { name: 'konflikt', status: 'abgelehnt', zugewiesen_an: '1', konto_id: kontoA, freigabe2_eskaliert_von: '3' });
  job(db, { name: 'f2', status: 'freigabe2', zugewiesen_an: '1', konto_id: kontoA, freigabe2_umgeleitet_an: '7' });
  const v = Object.fromEntries(listLaufendeVorgaenge(db).map((x) => [x.dateiname, x]));

  assert.equal(v['konto.pdf'].zustaendig.name, 'P1 M');
  assert.deepEqual([v['konto.pdf'].prognoseF2.name, v['konto.pdf'].prognoseF2.prognose], ['P3 M', false]);
  assert.deepEqual([v['kreditor.pdf'].prognoseF2.name, v['kreditor.pdf'].prognoseF2.prognose], ['P7 M', true]);
  assert.equal(v['hinweis.pdf'].zustaendig.art, 'pool');
  assert.deepEqual([v['hinweis.pdf'].prognoseF2.name, v['hinweis.pdf'].prognoseF2.prognose], ['P3 M', true]);
  assert.equal(v['offen.pdf'].prognoseF2.offen, true);
  assert.equal(v['konflikt.pdf'].prognoseF2.name, 'P4 M');
  assert.equal(v['f2.pdf'].prognoseF2, null);
  assert.equal(v['f2.pdf'].zustaendig.name, 'P7 M');
  assert.ok(v['f2.pdf'].kennzeichen.includes('umgeleitet'));
  db.close();
});

test('Kennzeichen hängt und überfällig; Filter nurProbleme, status, art, personId', () => {
  const db = openDatabase(':memory:');
  const { kontoA } = seed(db);
  deactivatePerson(db, '2', 'churchtools_geloescht');
  job(db, { name: 'haengt', status: 'zugewiesen', zugewiesen_an: '2', konto_id: kontoA });
  job(db, { name: 'ueberfaellig', status: 'freigabe2', konto_id: kontoA, freigabe2_seit: '2020-01-01T00:00:00.000Z' });
  job(db, { name: 'ok', status: 'zugewiesen', zugewiesen_an: '1', konto_id: kontoA, typ: 'gutschrift' });
  const alle = Object.fromEntries(listLaufendeVorgaenge(db).map((x) => [x.dateiname, x]));
  assert.equal(alle['haengt.pdf'].haengt, true);
  assert.equal(alle['ueberfaellig.pdf'].ueberfaellig, true);
  assert.equal(alle['ok.pdf'].artLabel, 'Gutschrift');

  assert.deepEqual(listLaufendeVorgaenge(db, { nurProbleme: true }).map((x) => x.dateiname).sort(), ['haengt.pdf', 'ueberfaellig.pdf']);
  assert.deepEqual(listLaufendeVorgaenge(db, { status: 'freigabe2' }).map((x) => x.dateiname), ['ueberfaellig.pdf']);
  assert.deepEqual(listLaufendeVorgaenge(db, { art: 'gutschrift' }).map((x) => x.dateiname), ['ok.pdf']);
  assert.deepEqual(listLaufendeVorgaenge(db, { personId: '1' }).map((x) => x.dateiname), ['ok.pdf']);
  db.close();
});

test('seit: Freigabe 2 nimmt freigabe2_seit, Kontierung den letzten Verlaufseintrag', () => {
  const db = openDatabase(':memory:');
  const { kontoA } = seed(db);
  const id = job(db, { name: 'k', status: 'zugewiesen', zugewiesen_an: '1', konto_id: kontoA });
  createFreigabe(db, { jobId: id, personId: '1', rolle: 'pool_zuweisung', zeitpunkt: '2026-10-03T08:00:00.000Z', ip: '1', interessenskonflikt: false, kommentar: null, eskaliertVon: null });
  job(db, { name: 'f', status: 'freigabe2', konto_id: kontoA, freigabe2_seit: '2026-10-04T08:00:00.000Z' });
  const v = Object.fromEntries(listLaufendeVorgaenge(db).map((x) => [x.dateiname, x]));
  assert.equal(v['k.pdf'].seit, '2026-10-03T08:00:00.000Z');
  assert.equal(v['f.pdf'].seit, '2026-10-04T08:00:00.000Z');
  db.close();
});

test('hängt folgt listStalledJobs: F2 ohne Konto nicht, eskalierte Kontierung mit inaktiver Person ja', () => {
  const db = openDatabase(':memory:');
  const { kontoA } = seed(db);
  deactivatePerson(db, '2', 'churchtools_geloescht');
  job(db, { name: 'ohnekonto', status: 'freigabe2' });
  job(db, { name: 'eskaliert', status: 'zugewiesen', zugewiesen_an: '2', konto_id: kontoA, freigabe1_eskaliert_an_admin: 1 });
  const v = Object.fromEntries(listLaufendeVorgaenge(db).map((x) => [x.dateiname, x]));
  assert.equal(v['ohnekonto.pdf'].haengt, false);
  assert.equal(v['eskaliert.pdf'].haengt, true);
  db.close();
});

test('admin-eskalierte Freigabe 2 ist nie überfällig', () => {
  const db = openDatabase(':memory:');
  const { kontoA } = seed(db);
  job(db, { name: 'esk', status: 'freigabe2', konto_id: kontoA, freigabe2_seit: '2020-01-01T00:00:00.000Z', freigabe2_eskaliert_an_admin: 1 });
  assert.equal(listLaufendeVorgaenge(db)[0].ueberfaellig, false);
  db.close();
});
