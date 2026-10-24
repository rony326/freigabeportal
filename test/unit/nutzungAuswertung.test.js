import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { uebersicht, personDetail, median, p90 } from '../../src/services/nutzungAuswertung.js';

const VON = '2026-10-01T00:00:00.000Z';
const BIS = '2026-10-24T00:00:00.000Z';

function aufruf(db, { zeitpunkt = '2026-10-10T10:00:00.000Z', person = '1', pfad = '/pool', muster = pfad, dauer = 100, typ = 'desktop', browser = 'Firefox 130', os = 'Linux' } = {}) {
  db.prepare(`INSERT INTO nutzung_seitenaufrufe (zeitpunkt, person_id, methode, pfad, pfad_muster, status, dauer_ms, geraet_typ, browser, betriebssystem)
    VALUES (?, ?, 'GET', ?, ?, 200, ?, ?, ?, ?)`).run(zeitpunkt, person, pfad, muster, dauer, typ, browser, os);
}

function fehler(db, requestId, zeitpunkt, person = '1') {
  db.prepare("INSERT INTO betrieb_fehler (request_id, zeitpunkt, person_id, methode, pfad, status, meldung, stack) VALUES (?, ?, ?, 'GET', '/x', 500, 'boom', 'Error: boom\n    at x')").run(requestId, zeitpunkt, person);
}

test('median und p90 (nearest rank)', () => {
  assert.equal(median([]), null);
  assert.equal(median([5]), 5);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 3); // (2+3)/2 gerundet
  assert.equal(p90([]), null);
  assert.equal(p90(Array.from({ length: 10 }, (_, i) => i + 1)), 9);
  assert.equal(p90(Array.from({ length: 20 }, (_, i) => i + 1)), 18);
  assert.equal(p90([7]), 7);
});

test('Übersicht aggregiert korrekt', () => {
  const db = openDatabase(':memory:');
  aufruf(db, { person: '1', pfad: '/pool', dauer: 100 });
  aufruf(db, { person: '1', pfad: '/pool', dauer: 300 });
  aufruf(db, { person: '2', pfad: '/pool', dauer: 200, typ: 'handy', browser: 'Safari 18', os: 'iOS' });
  aufruf(db, { person: '2', pfad: '/kontierung/5', muster: '/kontierung/:id', dauer: 50, typ: 'handy', browser: 'Safari 18', os: 'iOS' });
  // ausserhalb des Zeitraums
  aufruf(db, { zeitpunkt: '2026-09-01T00:00:00.000Z', person: '3' });
  aufruf(db, { zeitpunkt: BIS, person: '3' });
  fehler(db, 'a'.repeat(32), '2026-10-10T08:00:00.000Z');
  fehler(db, 'b'.repeat(32), '2026-10-10T21:30:00.000Z'); // Zürich: 10.10. 23:30
  fehler(db, 'c'.repeat(32), '2026-10-10T22:30:00.000Z', '2'); // Zürich: 11.10. 00:30
  fehler(db, 'd'.repeat(32), '2026-09-10T08:00:00.000Z');

  const u = uebersicht(db, { von: VON, bis: BIS });
  assert.equal(u.aktivePersonen, 2);
  assert.equal(u.seitenaufrufe, 4);
  assert.deepEqual(u.geraeteTypen, [{ wert: 'desktop', anzahl: 2 }, { wert: 'handy', anzahl: 2 }]);
  assert.deepEqual(u.browser, [{ wert: 'Firefox 130', anzahl: 2 }, { wert: 'Safari 18', anzahl: 2 }]);
  assert.deepEqual(u.betriebssysteme, [{ wert: 'iOS', anzahl: 2 }, { wert: 'Linux', anzahl: 2 }]);
  assert.deepEqual(u.topSeiten, [
    { pfadMuster: '/pool', anzahl: 3, medianMs: 200 },
    { pfadMuster: '/kontierung/:id', anzahl: 1, medianMs: 50 },
  ]);
  assert.deepEqual(u.langsameSeiten, [], 'unter 20 Aufrufen keine langsame Seite');
  assert.deepEqual(u.fehlerProTag, [{ tag: '2026-10-10', anzahl: 2 }, { tag: '2026-10-11', anzahl: 1 }]);

  const nurZwei = uebersicht(db, { von: VON, bis: BIS, personId: '2' });
  assert.equal(nurZwei.aktivePersonen, 1);
  assert.equal(nurZwei.seitenaufrufe, 2);
  assert.deepEqual(nurZwei.fehlerProTag, [{ tag: '2026-10-11', anzahl: 1 }]);
  db.close();
});

test('langsame Seiten: min. 20 Aufrufe, nach p90 absteigend, höchstens 10', () => {
  const db = openDatabase(':memory:');
  for (let i = 1; i <= 20; i++) aufruf(db, { pfad: '/langsam', dauer: i * 100 });
  for (let i = 1; i <= 25; i++) aufruf(db, { pfad: '/schnell', dauer: i });
  for (let i = 1; i <= 19; i++) aufruf(db, { pfad: '/selten', dauer: 99999 });
  for (let s = 0; s < 11; s++) for (let i = 0; i < 20; i++) aufruf(db, { pfad: `/s${s}`, dauer: 10 + s });
  const u = uebersicht(db, { von: VON, bis: BIS });
  assert.equal(u.langsameSeiten.length, 10);
  assert.deepEqual(u.langsameSeiten[0], { pfadMuster: '/langsam', anzahl: 20, medianMs: 1050, p90Ms: 1800 });
  assert.ok(!u.langsameSeiten.some((s) => s.pfadMuster === '/selten'));
  const p90s = u.langsameSeiten.map((s) => s.p90Ms);
  assert.deepEqual(p90s, [...p90s].sort((a, b) => b - a));
  db.close();
});

test('Personendetail: Anmeldungen, Geräte, letzte Aufrufe, Fehler, Meldungen', () => {
  const db = openDatabase(':memory:');
  for (let i = 0; i < 60; i++) {
    db.prepare("INSERT INTO nutzung_anmeldungen (zeitpunkt, person_id, erfolg, ip) VALUES (?, '1', 1, '10.0.0.1')")
      .run(new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString());
  }
  db.prepare("INSERT INTO nutzung_anmeldungen (zeitpunkt, person_id, erfolg) VALUES ('2026-10-01T00:00:00.000Z', '2', 1)").run();
  for (let i = 0; i < 110; i++) aufruf(db, { zeitpunkt: new Date(Date.UTC(2026, 9, 2, 0, i)).toISOString(), pfad: `/p${i}` });
  aufruf(db, { person: '2' });
  db.prepare("INSERT INTO nutzung_geraete (geraet_id, person_id, erstmals_am, zuletzt_am, geraet_typ, browser, betriebssystem) VALUES ('g1', '1', '2026-10-01', '2026-10-02', 'desktop', 'Firefox 130', 'Linux')").run();
  db.prepare("INSERT INTO nutzung_geraete (geraet_id, person_id, erstmals_am, zuletzt_am) VALUES ('g2', '2', '2026-10-01', '2026-10-02')").run();
  fehler(db, 'e'.repeat(32), '2026-10-05T00:00:00.000Z');
  fehler(db, 'f'.repeat(32), '2026-10-05T00:00:00.000Z', '2');
  db.prepare("INSERT INTO betrieb_fehlermeldungen (zeitpunkt, person_id, beschreibung) VALUES ('2026-10-05T00:00:00.000Z', '1', 'Hilfe')").run();

  const d = personDetail(db, '1');
  assert.equal(d.anmeldungen.length, 50);
  assert.equal(d.anmeldungen[0].zeitpunkt, new Date(Date.UTC(2026, 9, 1, 0, 59)).toISOString(), 'neueste zuerst');
  assert.equal(d.letzteAufrufe.length, 100);
  assert.equal(d.letzteAufrufe[0].pfad, '/p109');
  assert.deepEqual(d.geraete.map((g) => g.geraet_id), ['g1']);
  assert.deepEqual(d.fehler.map((f) => f.request_id), ['e'.repeat(32)]);
  assert.deepEqual(d.meldungen.map((m) => m.beschreibung), ['Hilfe']);
  db.close();
});
