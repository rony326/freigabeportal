import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { withAuditActor } from '../../src/services/auditContext.js';
import {
  protokolliereZugriffVerweigerung, zugriffsBereich, EINZEL_PRO_FENSTER, DROSSELHINWEISE_PRO_FENSTER,
  SCHLUESSEL_PRO_FENSTER, FENSTER_MS,
} from '../../src/services/zugriffsAudit.js';

const req = (url, method = 'GET') => ({ originalUrl: url, method });
const count = (db, aktion) => db.prepare('SELECT count(*) AS n FROM audit_ereignisse WHERE aktion = ?').get(aktion).n;

test('Bereich stammt aus einer festen Liste und enthaelt keine IDs oder Query-Werte', () => {
  assert.equal(zugriffsBereich(req('/admin/konten/5/bearbeiten?x=1')), '/admin/konten');
  assert.equal(zugriffsBereich(req('/admin/unbekannt-123')), '/admin');
  assert.equal(zugriffsBereich(req('/api/n8n/kk-belege/7')), '/api/n8n/kk-belege');
  assert.equal(zugriffsBereich(req('/api/n8n/anderes')), '/api/n8n');
  assert.equal(zugriffsBereich(req('/downloads/17?sig=abc')), '/downloads');
  assert.equal(zugriffsBereich(req('/%2e%2e/etc/passwd')), 'sonstige');
  assert.equal(zugriffsBereich(req('/')), '/');
});

test('ungueltige Angaben werden nicht protokolliert und werfen nicht', (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const originalError = console.error;
  console.error = () => {};
  try {
    assert.equal(protokolliereZugriffVerweigerung(db, req('/admin'), { grund: 'frei erfunden', status: 403 }), false);
    assert.equal(protokolliereZugriffVerweigerung(db, req('/admin'), { grund: 'csrf', status: 500 }), false);
  } finally { console.error = originalError; }
  assert.equal(count(db, 'zugriff_verweigert'), 0);
});

test('nur Rechte aus dem Katalogformat werden uebernommen', (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  protokolliereZugriffVerweigerung(db, req('/admin/konten'), { grund: 'fehlendes_recht', status: 403, recht: '<script>' });
  const event = db.prepare("SELECT nachher FROM audit_ereignisse WHERE aktion = 'zugriff_verweigert'").get();
  assert.equal(JSON.parse(event.nachher).recht, undefined);
});

test('globale Obergrenzen begrenzen Einzelereignisse, Drosselhinweise und Schluessel je Fenster', (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const now = new Date('2026-09-29T10:15:00Z');
  for (let person = 0; person < SCHLUESSEL_PRO_FENSTER + 30; person++) {
    for (let i = 0; i < 4; i++) {
      withAuditActor({ id: `p${person}`, name: `Person ${person}` }, () =>
        protokolliereZugriffVerweigerung(db, req('/admin/konten'), { grund: 'nicht_angemeldet', status: 401 }, now));
    }
  }
  assert.equal(count(db, 'zugriff_verweigert'), EINZEL_PRO_FENSTER);
  assert.equal(count(db, 'zugriff_verweigert_gedrosselt'), DROSSELHINWEISE_PRO_FENSTER);
  const fenster = '2026-09-29T10:00:00.000Z';
  assert.equal(db.prepare("SELECT count(*) AS n FROM audit_zugriff_drosselung WHERE fenster_start = ? AND schluessel NOT LIKE '#%'").get(fenster).n, SCHLUESSEL_PRO_FENSTER);
  const ueberlauf = db.prepare("SELECT anzahl FROM audit_zugriff_drosselung WHERE fenster_start = ? AND schluessel = '#ueberlauf'").get(fenster);
  assert.equal(ueberlauf.anzahl, 30 * 4);
  // Ein neues Fenster beginnt wieder mit Einzelereignissen.
  protokolliereZugriffVerweigerung(db, req('/admin/konten'), { grund: 'csrf', status: 403 }, new Date(now.getTime() + FENSTER_MS));
  assert.equal(count(db, 'zugriff_verweigert'), EINZEL_PRO_FENSTER + 1);
});

test('dieselbe Anfrage wird nur einmal protokolliert', (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const anfrage = req('/admin/backup', 'POST');
  assert.equal(protokolliereZugriffVerweigerung(db, anfrage, { grund: 'csrf', status: 403 }), true);
  assert.equal(protokolliereZugriffVerweigerung(db, anfrage, { grund: 'fehlende_rolle', status: 403 }), false);
  assert.equal(count(db, 'zugriff_verweigert'), 1);
});

test('Protokoll innerhalb einer fremden Transaktion bleibt Teil dieser Transaktion', (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  db.exec('BEGIN');
  protokolliereZugriffVerweigerung(db, req('/admin'), { grund: 'nicht_angemeldet', status: 401 });
  db.exec('ROLLBACK');
  assert.equal(count(db, 'zugriff_verweigert'), 0);
  assert.equal(db.isTransaction, false);
});
