import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createKreditor } from '../../src/db/kreditorenRepo.js';
import { createKreditorIban } from '../../src/db/kreditorIbanRepo.js';
import { ibanAlterHinweis, IBAN_NEU_TAGE } from '../../src/services/ibanAlter.js';

// S4: Hinweis in Freigabe 2, wenn die IBAN der Rechnung jünger als 14 Tage ist.
const TAG = 24 * 3600 * 1000;
const JETZT = Date.parse('2026-11-15T12:00:00.000Z');
const IBAN = 'CH9300762011623852957';

function aufsetzen({ alterMs, qrIban = IBAN, erstelltVon = '5' }) {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '5', vorname: 'Erika', nachname: 'Erfasst', email: 'e@example.org', gruppen: [], loggedInNow: false });
  const kreditorId = createKreditor(db, { name: 'Muster AG', kontoId: null, zahlungsart: 'ueberweisung' });
  const id = createKreditorIban(db, { kreditorId, iban: IBAN, erstelltVon });
  db.prepare('UPDATE kreditor_ibans SET erstellt_am = ? WHERE id = ?').run(new Date(JETZT - alterMs).toISOString(), id);
  return { db, job: { id: 1, quelle: 'scanner', kreditor_id: kreditorId, qr_iban: qrIban } };
}

test('Schwelle ist 14 Tage', () => assert.equal(IBAN_NEU_TAGE, 14));

test('IBAN jünger als 14 Tage: Hinweis mit Datum und Erfasser', () => {
  const { db, job } = aufsetzen({ alterMs: 3 * TAG });
  const h = ibanAlterHinweis(db, job, { jetzt: JETZT });
  assert.ok(h);
  assert.equal(h.iban, 'CH93 … 2957');
  assert.equal(h.erfasstVon, 'Erika Erfasst');
  assert.match(h.datum, /^12\.11\.2026 \d\d:\d\d$/);
  assert.equal(h.fuerRechnung, true);
  db.close();
});

test('Grenzfall: knapp unter 14 Tagen warnt, genau 14 Tage und älter nicht', () => {
  for (const [alterMs, erwartet] of [[14 * TAG - 1, true], [14 * TAG, false], [14 * TAG + 1, false], [60 * TAG, false], [0, true]]) {
    const { db, job } = aufsetzen({ alterMs });
    assert.equal(Boolean(ibanAlterHinweis(db, job, { jetzt: JETZT })), erwartet, `Alter ${alterMs} ms`);
    db.close();
  }
});

test('Erfasser unbekannt (Altbestand ohne erstellt_von): Hinweis nennt "unbekannt"', () => {
  const { db, job } = aufsetzen({ alterMs: TAG, erstelltVon: null });
  db.prepare('UPDATE kreditor_ibans SET erstellt_von = NULL').run();
  assert.equal(ibanAlterHinweis(db, job, { jetzt: JETZT }).erfasstVon, 'unbekannt');
  db.close();
});

test('Rechnung mit anderer (alter) QR-IBAN beim selben Lieferanten: kein Hinweis auf die junge IBAN', () => {
  const { db, job } = aufsetzen({ alterMs: TAG, qrIban: 'CH4431999123000889012' });
  assert.equal(ibanAlterHinweis(db, job, { jetzt: JETZT }), null);
  db.close();
});

test('Ohne QR-IBAN: junge IBAN des Lieferanten genügt für den Hinweis (fuerRechnung = false)', () => {
  const { db, job } = aufsetzen({ alterMs: TAG, qrIban: null });
  const h = ibanAlterHinweis(db, job, { jetzt: JETZT });
  assert.ok(h);
  assert.equal(h.fuerRechnung, false);
  db.close();
});

test('Kein Lieferant, Spesen oder keine IBAN: kein Hinweis', () => {
  const { db, job } = aufsetzen({ alterMs: TAG });
  assert.equal(ibanAlterHinweis(db, { ...job, kreditor_id: null }, { jetzt: JETZT }), null);
  assert.equal(ibanAlterHinweis(db, { ...job, quelle: 'spesen' }, { jetzt: JETZT }), null);
  db.close();
});
