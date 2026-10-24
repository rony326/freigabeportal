import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { aktiveBanner, pruefeBannerEingabe, blendeBannerAus } from '../../src/services/banner.js';

function frischeDb() {
  const db = openDatabase(':memory:');
  db.exec('DELETE FROM banner; DELETE FROM banner_ausgeblendet');
  return db;
}
function neu(db, art, text, von, bis, aktiv = 1, link = null) {
  return db.prepare('INSERT INTO banner (art, text, link, von, bis, aktiv) VALUES (?, ?, ?, ?, ?, ?)').run(art, text, link, von, bis, aktiv).lastInsertRowid;
}
const JETZT = new Date('2026-10-24T12:00:00.000Z');

test('Zeitraum und aktiv steuern Sichtbarkeit', () => {
  const db = frischeDb();
  neu(db, 'info', 'ok', '2026-10-24T00:00:00.000Z', '2026-10-25T00:00:00.000Z');
  neu(db, 'info', 'zukunft', '2026-10-25T00:00:00.000Z', '2026-10-26T00:00:00.000Z');
  neu(db, 'info', 'vorbei', '2026-10-01T00:00:00.000Z', '2026-10-02T00:00:00.000Z');
  neu(db, 'info', 'inaktiv', '2026-10-24T00:00:00.000Z', '2026-10-25T00:00:00.000Z', 0);
  assert.deepEqual(aktiveBanner(db, '1', JETZT).map((b) => b.text), ['ok']);
  db.close();
});

test('Info wegklickbar, Wartung nicht', () => {
  const db = frischeDb();
  const info = neu(db, 'info', 'i', '2026-10-24T00:00:00.000Z', '2026-10-25T00:00:00.000Z');
  const wartung = neu(db, 'wartung', 'w', '2026-10-24T00:00:00.000Z', '2026-10-25T00:00:00.000Z');
  assert.deepEqual(aktiveBanner(db, '1', JETZT).map((b) => b.wegklickbar), [false, true]);
  assert.equal(blendeBannerAus(db, wartung, '1'), 'nicht_wegklickbar');
  assert.equal(blendeBannerAus(db, 999, '1'), 'nicht_gefunden');
  assert.equal(blendeBannerAus(db, info, '1'), 'ok');
  assert.equal(blendeBannerAus(db, info, '1'), 'ok');
  assert.deepEqual(aktiveBanner(db, '1', JETZT).map((b) => b.text), ['w']);
  assert.deepEqual(aktiveBanner(db, '2', JETZT).map((b) => b.text), ['w', 'i']);
  db.close();
});

test('Reihenfolge: wartung, warnung, info, dann von aufsteigend', () => {
  const db = frischeDb();
  const bis = '2026-10-30T00:00:00.000Z';
  neu(db, 'info', 'i-spaet', '2026-10-24T10:00:00.000Z', bis);
  neu(db, 'info', 'i-frueh', '2026-10-24T08:00:00.000Z', bis);
  neu(db, 'warnung', 'warn', '2026-10-24T09:00:00.000Z', bis);
  neu(db, 'wartung', 'wart', '2026-10-24T11:00:00.000Z', bis);
  assert.deepEqual(aktiveBanner(db, '1', JETZT).map((b) => b.text), ['wart', 'warn', 'i-frueh', 'i-spaet']);
  db.close();
});

test('Eingabeprüfung: Link nur https:// oder /, kein javascript:', () => {
  const ok = { art: 'info', text: 'Hallo', link: '', von: '2026-10-24T10:00', bis: '2026-10-25T10:00' };
  assert.deepEqual(pruefeBannerEingabe(ok), []);
  assert.deepEqual(pruefeBannerEingabe({ ...ok, link: 'https://example.org/x' }), []);
  assert.deepEqual(pruefeBannerEingabe({ ...ok, link: '/datenschutz' }), []);
  for (const link of ['javascript:alert(1)', '//evil.org', 'http://example.org', 'data:text/html,x', '/\\evil.org']) {
    assert.equal(pruefeBannerEingabe({ ...ok, link }).length, 1, link);
  }
  assert.equal(pruefeBannerEingabe({ ...ok, art: 'x' }).length, 1);
  assert.equal(pruefeBannerEingabe({ ...ok, text: '  ' }).length, 1);
  assert.equal(pruefeBannerEingabe({ ...ok, text: 'a'.repeat(1001) }).length, 1);
  assert.equal(pruefeBannerEingabe({ ...ok, bis: '2026-10-23T10:00' }).length, 1);
  assert.equal(pruefeBannerEingabe({ ...ok, von: 'kaputt' }).length, 1);
});

test('Datenschutz-Banner einmalig geseedet', () => {
  const db = openDatabase(':memory:');
  const alle = () => db.prepare('SELECT * FROM banner').all();
  assert.equal(alle().length, 1);
  assert.equal(alle()[0].art, 'info');
  assert.equal(alle()[0].link, '/datenschutz');
  db.exec('DELETE FROM banner');
  // erneute Migration (Neustart) legt ihn nicht wieder an
  return import('../../src/db/betriebSchema.js').then(({ migrateBetriebSchema }) => {
    migrateBetriebSchema(db);
    assert.equal(alle().length, 0);
    db.close();
  });
});
