import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { seedDefaults } from '../../src/db/adminConfigRepo.js';
import { runNutzungsdatenBereinigungJob } from '../../src/services/nutzungBereinigung.js';

const TAG = 24 * 3600 * 1000;
const JETZT = new Date('2026-10-24T03:45:00.000Z');
const vor = (tage) => new Date(JETZT.getTime() - tage * TAG).toISOString();

function setup(t) {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  seedDefaults(db);
  return db;
}
const anzahl = (db, tabelle) => db.prepare(`SELECT COUNT(*) AS n FROM ${tabelle}`).get().n;

test('löscht genau nach Frist (89/91 Tage, 364/366 Tage)', async (t) => {
  const db = setup(t);
  for (const tage of [89, 91]) {
    db.prepare("INSERT INTO nutzung_seitenaufrufe (zeitpunkt, person_id, pfad, pfad_muster) VALUES (?, 'p', '/x', '/x')").run(vor(tage));
  }
  for (const tage of [364, 366]) {
    db.prepare("INSERT INTO nutzung_anmeldungen (zeitpunkt, person_id, erfolg) VALUES (?, 'p', 1)").run(vor(tage));
    db.prepare('INSERT INTO betrieb_fehler (request_id, zeitpunkt) VALUES (?, ?)').run(`r${tage}`, vor(tage));
    db.prepare("INSERT INTO betrieb_fehlermeldungen (zeitpunkt, person_id) VALUES (?, 'p')").run(vor(tage));
    db.prepare('INSERT INTO nutzung_geraete (geraet_id, person_id, zuletzt_am) VALUES (?, ?, ?)').run(`g${tage}`, 'p', vor(tage));
    db.prepare("INSERT INTO banner (art, text, von, bis) VALUES ('info', 'x', ?, ?)").run(vor(tage + 10), vor(tage));
  }
  db.prepare("INSERT INTO banner_ausgeblendet (banner_id, person_id) SELECT id, 'p' FROM banner").run();

  const res = await runNutzungsdatenBereinigungJob(db, {}, {}, { jetzt: JETZT });
  assert.equal(res.status, 'erfolg');
  assert.deepEqual(res.geloescht, { seitenaufrufe: 1, anmeldungen: 1, fehler: 1, meldungen: 1, geraete: 1, bannerAusgeblendet: 1 });
  assert.equal(db.prepare('SELECT zeitpunkt FROM nutzung_seitenaufrufe').get().zeitpunkt, vor(89));
  assert.equal(db.prepare('SELECT zeitpunkt FROM nutzung_anmeldungen').get().zeitpunkt, vor(364));
  assert.equal(db.prepare('SELECT request_id FROM betrieb_fehler').get().request_id, 'r364');
  assert.equal(anzahl(db, 'betrieb_fehlermeldungen'), 1);
  assert.equal(db.prepare('SELECT geraet_id FROM nutzung_geraete').get().geraet_id, 'g364');
  assert.equal(anzahl(db, 'banner_ausgeblendet'), 2, 'Datenschutz-Banner und Banner von vor 364 Tagen bleiben');
  assert.equal(anzahl(db, 'banner'), 3, 'Banner selbst bleiben (inkl. Datenschutz-Banner)');
});
