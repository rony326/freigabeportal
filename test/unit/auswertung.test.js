import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createKonto } from '../../src/db/kontenRepo.js';
import { setzeBudget } from '../../src/db/budgetRepo.js';
import {
  parseZeitraum, zugangFuer, kennzahlen, budgetProKonto, durchlaufzeiten, engpaesse, lieferanten,
  median, perzentil90, formatChf, zuerichDatum, parseBetrag,
} from '../../src/services/auswertung.js';

const CONFIG = { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20', groupIdManager: '30' } };
const JAHR = { von: '2026-01-01', bis: '2026-12-31' };

function setup() {
  const db = openDatabase(':memory:');
  for (const [id, vorname, nachname] of [['1', 'Anna', 'Eins'], ['2', 'Beat', 'Zwei'], ['3', 'Carla', 'Drei'], ['9', 'Kurt', 'Kassier']]) {
    upsertPerson(db, { id, vorname, nachname, email: `${id}@x.ch`, gruppen: [], loggedInNow: false });
  }
  const a = Number(createKonto(db, { kontonummer: '4000', bezeichnung: 'Jugend', freigeber1Id: '1', stellvertreter1Id: '3', freigeber2Id: '2', stellvertreter2Id: '9' }));
  const b = Number(createKonto(db, { kontonummer: '4100', bezeichnung: 'Musik', freigeber1Id: '2', stellvertreter1Id: '9', freigeber2Id: '1', stellvertreter2Id: '9' }));
  return { db, a, b };
}

function job(db, felder) {
  const werte = { eingang_am: '2026-03-01T08:00:00Z', quelle: 'scanner', dateiname: 'x.pdf', pdf_pfad: '/x.pdf', status: 'abgeschlossen', ...felder };
  if (['abgeschlossen', 'abgeholt', 'archiviert'].includes(werte.status) && !('abgeschlossen_am' in felder)) werte.abgeschlossen_am = '2026-03-10T08:00:00Z';
  const spalten = Object.keys(werte);
  const r = db.prepare(`INSERT INTO jobs (${spalten.join(',')}) VALUES (${spalten.map(() => '?').join(',')})`).run(...Object.values(werte));
  return Number(r.lastInsertRowid);
}

function kreditor(db, name) {
  return Number(db.prepare('INSERT INTO kreditoren (name) VALUES (?)').run(name).lastInsertRowid);
}

function audit(db, jobId, zeitpunkt, vorher, nachher) {
  db.prepare(`INSERT INTO audit_ereignisse (zeitpunkt, person_id, person_name, objekt, objekt_id, aktion, vorher, nachher)
    VALUES (?, 'system', 'System', 'jobs', ?, 'UPDATE', ?, ?)`).run(zeitpunkt, String(jobId), JSON.stringify(vorher), JSON.stringify(nachher));
}

function freigabe(db, jobId, rolle, zeitpunkt, personId = '1') {
  db.prepare("INSERT INTO freigaben (job_id, person_id, rolle, zeitpunkt, ip) VALUES (?, ?, ?, ?, '::1')").run(jobId, personId, rolle, zeitpunkt);
}

test('Zählregeln: Gutschrift abgezogen; abgelehnt, gelöscht, Split-Eltern und Rapporte zählen nicht', () => {
  const { db, a, b } = setup();
  job(db, { konto_id: a, betrag: '100' });
  job(db, { konto_id: a, betrag: '30', typ: 'gutschrift' });
  job(db, { konto_id: a, betrag: '50', status: 'abgelehnt' });
  job(db, { konto_id: a, betrag: '70', status: 'geloescht' });
  job(db, { konto_id: a, betrag: '999', typ: 'rapport' });
  const eltern = job(db, { konto_id: a, betrag: '200', status: 'aufgesplittet' });
  job(db, { konto_id: a, betrag: '120', aufgesplittet_von: eltern });
  job(db, { konto_id: b, betrag: '80', aufgesplittet_von: eltern, status: 'archiviert' });
  job(db, { konto_id: b, betrag: '10', quelle: 'spesen', status: 'abgeholt' });
  const k = kennzahlen(db, { ...JAHR, kontoIds: null, schwelleTage: 14, heute: '2026-11-07' });
  assert.equal(k.freigegeben.betrag, 280);
  assert.equal(k.freigegeben.anzahl, 5);
  const zeilen = budgetProKonto(db, { ...JAHR, budgetJahr: 2026, kontoIds: null });
  assert.equal(zeilen.find((z) => z.kontoId === a).freigegeben, 190);
  assert.equal(zeilen.find((z) => z.kontoId === b).freigegeben, 90);
  db.close();
});

test('Zürcher Datumsgrenze: 31.12. 23:30 Lokalzeit gehört ins alte Jahr, 00:30 ins neue', () => {
  const { db, a } = setup();
  job(db, { konto_id: a, betrag: '10', abgeschlossen_am: '2026-12-31T22:30:00Z' });
  job(db, { konto_id: a, betrag: '20', abgeschlossen_am: '2026-12-31T23:30:00Z' });
  const alt = kennzahlen(db, { ...JAHR, kontoIds: null, schwelleTage: 14, heute: '2027-01-05' });
  const neu = kennzahlen(db, { von: '2027-01-01', bis: '2027-12-31', kontoIds: null, schwelleTage: 14, heute: '2027-01-05' });
  assert.equal(alt.freigegeben.betrag, 10);
  assert.equal(neu.freigegeben.betrag, 20);
  assert.equal(zuerichDatum('2026-12-31T23:30:00Z'), '2027-01-01');
  assert.equal(zuerichDatum('2026-07-31T22:30:00Z'), '2026-08-01');
  db.close();
});

test('in Freigabe: aktueller Stand, Pool nur in der Kennzahl; länger offen ab Schwelle', () => {
  const { db, a } = setup();
  job(db, { konto_id: a, betrag: '40', status: 'zugewiesen', zugewiesen_an: '1', eingang_am: '2026-10-01T08:00:00Z' });
  job(db, { konto_id: a, betrag: '60', status: 'freigabe2', eingang_am: '2026-11-01T08:00:00Z' });
  job(db, { betrag: '5', status: 'unzugewiesen', eingang_am: '2026-11-06T08:00:00Z' });
  const k = kennzahlen(db, { ...JAHR, kontoIds: null, schwelleTage: 14, heute: '2026-11-07' });
  assert.deepEqual(k.inFreigabe, { betrag: 105, anzahl: 3 });
  assert.equal(k.langeOffen.anzahl, 1);
  assert.equal(k.langeOffen.aeltesteTage, 37);
  const zeile = budgetProKonto(db, { ...JAHR, budgetJahr: 2026, kontoIds: null }).find((z) => z.kontoId === a);
  assert.equal(zeile.inFreigabe, 100);
  db.close();
});

test('kein Budget: budget und Ausschöpfung null, keine Exception; über Budget markiert', () => {
  const { db, a, b } = setup();
  job(db, { konto_id: a, betrag: '150' });
  job(db, { konto_id: b, betrag: '50' });
  setzeBudget(db, { kontoId: a, jahr: 2026, betrag: 100, personId: '9' });
  const zeilen = budgetProKonto(db, { ...JAHR, budgetJahr: 2026, kontoIds: null });
  const za = zeilen.find((z) => z.kontoId === a);
  const zb = zeilen.find((z) => z.kontoId === b);
  assert.equal(za.budget, 100);
  assert.equal(za.ausschoepfung, 1.5);
  assert.equal(za.ueberBudget, true);
  assert.equal(za.verantwortlich, 'Anna Eins');
  assert.equal(zb.budget, null);
  assert.equal(zb.ausschoepfung, null);
  assert.equal(zb.ueberBudget, false);
  assert.deepEqual(zeilen.map((z) => z.kontonummer), ['4000', '4100']);
  db.close();
});

test('Budget über Jahre: Ausgaben nur aus dem Budget-Jahr, nicht aus dem ganzen Zeitraum', () => {
  const { db, a } = setup();
  job(db, { konto_id: a, betrag: '70', abgeschlossen_am: '2025-12-15T10:00:00Z' });
  job(db, { konto_id: a, betrag: '30', abgeschlossen_am: '2026-01-15T10:00:00Z' });
  const zeile = budgetProKonto(db, { von: '2025-11-07', bis: '2026-11-07', budgetJahr: 2026, kontoIds: null }).find((z) => z.kontoId === a);
  assert.equal(zeile.freigegeben, 30);
  db.close();
});

test('median und perzentil90', () => {
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([4, 1, 3]), 3);
  assert.equal(perzentil90([1, 2, 3, 4]), 4);
  assert.equal(median([5]), 5);
  assert.equal(perzentil90([5]), 5);
  assert.equal(median([]), null);
  assert.equal(perzentil90([]), null);
  assert.equal(perzentil90([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]), 10);
});

test('Durchlaufzeiten: Pool-Zeit aus Audit, 0 bei direkter Zuweisung; Freigabe 1 und 2', () => {
  const { db, a } = setup();
  const j1 = job(db, { konto_id: a, betrag: '1', eingang_am: '2026-03-01T00:00:00Z', abgeschlossen_am: '2026-03-08T00:00:00Z' });
  audit(db, j1, '2026-03-03T00:00:00Z', { status: 'unzugewiesen' }, { status: 'zugewiesen' });
  freigabe(db, j1, 'freigeber1', '2026-03-04T12:00:00Z');
  const j2 = job(db, { konto_id: a, betrag: '1', eingang_am: '2026-03-01T00:00:00Z', abgeschlossen_am: '2026-03-02T00:00:00Z' });
  freigabe(db, j2, 'freigeber1', '2026-03-01T12:00:00Z');
  job(db, { konto_id: a, betrag: '1', status: 'abgelehnt' });
  const stufen = Object.fromEntries(durchlaufzeiten(db, { ...JAHR, kontoIds: null }).map((s) => [s.stufe, s]));
  assert.deepEqual(stufen.pool, { stufe: 'pool', median: 1, p90: 2, anzahl: 2 });
  assert.deepEqual(stufen.freigabe1, { stufe: 'freigabe1', median: 1, p90: 1.5, anzahl: 2 });
  assert.deepEqual(stufen.freigabe2, { stufe: 'freigabe2', median: 2, p90: 3.5, anzahl: 2 });
  const k = kennzahlen(db, { ...JAHR, kontoIds: null, schwelleTage: 14, heute: '2026-11-07' });
  assert.equal(k.medianTage, 4);
  db.close();
});

test('Engpässe: gruppiert nach Person und Stufe, Pool und Admin-Gruppe eigene Zeilen, Alter seit Stufeneintritt', () => {
  const { db, a, b } = setup();
  const heute = '2026-11-07';
  const j1 = job(db, { konto_id: a, status: 'zugewiesen', zugewiesen_an: '1', eingang_am: '2026-10-01T08:00:00Z' });
  audit(db, j1, '2026-11-02T08:00:00Z', { status: 'unzugewiesen', zugewiesen_an: null }, { status: 'zugewiesen', zugewiesen_an: '1' });
  job(db, { konto_id: a, status: 'zugewiesen', zugewiesen_an: '1', eingang_am: '2026-11-04T08:00:00Z' });
  job(db, { konto_id: a, status: 'freigabe2', freigabe2_seit: '2026-10-28T08:00:00Z' });
  job(db, { konto_id: b, status: 'freigabe2', freigabe2_seit: '2026-11-06T08:00:00Z', freigabe2_eskaliert_an_admin: 1 });
  job(db, { status: 'unzugewiesen', eingang_am: '2026-10-20T08:00:00Z' });
  job(db, { konto_id: a, status: 'zugewiesen', zugewiesen_an: '1', quelle: 'spesen', eingang_am: '2026-11-01T08:00:00Z' });
  job(db, { konto_id: a, status: 'kenntnisnahme', typ: 'rapport' });
  const zeilen = engpaesse(db, { kontoIds: null, heute });
  assert.deepEqual(zeilen.map((z) => [z.name, z.stufe, z.anzahl, z.aeltesteTage]), [
    ['Pool', 'Pool', 1, 18],
    ['Beat Zwei', 'Freigabe 2', 1, 10],
    ['Anna Eins', 'Spesen-Freigabe 1', 1, 6],
    ['Anna Eins', 'Kontierung & Freigabe 1', 2, 5],
    ['Admin-Gruppe', 'Freigabe 2', 1, 1],
  ]);
  assert.equal(zeilen[0].art, 'pool');
  assert.equal(zeilen[1].personId, '2');
  assert.equal(zeilen[4].art, 'admin');
  db.close();
});

test('Lieferanten: Kreditor, Spesen und ohne Kreditor; Anteil und häufigste Konten', () => {
  const { db, a, b } = setup();
  const k1 = kreditor(db, 'Papeterie AG');
  job(db, { konto_id: a, betrag: '300', kreditor_id: k1 });
  job(db, { konto_id: b, betrag: '100', kreditor_id: k1 });
  job(db, { konto_id: a, betrag: '50', kreditor_id: k1, typ: 'gutschrift' });
  job(db, { konto_id: a, betrag: '100', quelle: 'spesen' });
  job(db, { konto_id: b, betrag: '100' });
  const zeilen = lieferanten(db, { ...JAHR, kontoIds: null });
  assert.deepEqual(zeilen.map((z) => [z.name, z.anzahl, z.betrag]), [
    ['Papeterie AG', 3, 350], ['(kein Kreditor)', 1, 100], ['Spesen (Rückerstattung)', 1, 100],
  ]);
  assert.equal(zeilen[0].anteil, 0.636);
  assert.deepEqual(zeilen[0].konten, ['4000', '4100']);
  db.close();
});

test('kontoIds-Filter wirkt auf alle Funktionen', () => {
  const { db, a, b } = setup();
  job(db, { konto_id: a, betrag: '10' });
  job(db, { konto_id: b, betrag: '20' });
  job(db, { konto_id: b, betrag: '20', status: 'zugewiesen', zugewiesen_an: '2' });
  job(db, { status: 'unzugewiesen', betrag: '5' });
  const f = { ...JAHR, kontoIds: [a] };
  assert.equal(kennzahlen(db, { ...f, schwelleTage: 14, heute: '2026-11-07' }).freigegeben.betrag, 10);
  assert.equal(kennzahlen(db, { ...f, schwelleTage: 14, heute: '2026-11-07' }).inFreigabe.anzahl, 0);
  assert.deepEqual(budgetProKonto(db, { ...f, budgetJahr: 2026 }).map((z) => z.kontoId), [a]);
  assert.equal(durchlaufzeiten(db, f).find((s) => s.stufe === 'freigabe2').anzahl, 1);
  assert.equal(engpaesse(db, { kontoIds: [a], heute: '2026-11-07' }).length, 0);
  assert.equal(lieferanten(db, f).reduce((s, z) => s + z.betrag, 0), 10);
  assert.equal(kennzahlen(db, { ...JAHR, kontoIds: [], schwelleTage: 14, heute: '2026-11-07' }).freigegeben.anzahl, 0);
  db.close();
});

test('ohneBetrag und inEur werden gezählt', () => {
  const { db, a } = setup();
  job(db, { konto_id: a, betrag: null });
  job(db, { konto_id: a, betrag: '10', qr_waehrung: 'EUR' });
  const k = kennzahlen(db, { ...JAHR, kontoIds: null, schwelleTage: 14, heute: '2026-11-07' });
  assert.equal(k.ohneBetrag, 1);
  assert.equal(k.inEur, 1);
  assert.equal(k.freigegeben.betrag, 10);
  db.close();
});

test('zugangFuer: Recht → alle; F1/SV1 → deren aktive Konten ohne Engpässe; sonst null', () => {
  const { db, a, b } = setup();
  db.prepare("INSERT INTO person_berechtigungen (person_id, berechtigung) VALUES ('9', 'auswertung_einsehen')").run();
  assert.deepEqual(zugangFuer(db, CONFIG, { churchtools_person_id: '9', gruppen: [] }), { alle: true, kontoIds: null, engpaesse: true });
  assert.deepEqual(zugangFuer(db, CONFIG, { churchtools_person_id: 'x', gruppen: ['20'] }), { alle: true, kontoIds: null, engpaesse: true });
  assert.deepEqual(zugangFuer(db, CONFIG, { churchtools_person_id: '1', gruppen: [] }), { alle: false, kontoIds: [a], engpaesse: false });
  assert.deepEqual(zugangFuer(db, CONFIG, { churchtools_person_id: '3', gruppen: [] }), { alle: false, kontoIds: [a], engpaesse: false });
  assert.deepEqual(zugangFuer(db, CONFIG, { churchtools_person_id: '2', gruppen: [] }), { alle: false, kontoIds: [b], engpaesse: false });
  db.prepare('UPDATE konten SET aktiv = 0 WHERE id = ?').run(b);
  assert.equal(zugangFuer(db, CONFIG, { churchtools_person_id: '2', gruppen: [] }), null);
  assert.equal(zugangFuer(db, CONFIG, null), null);
  db.close();
});

test('parseZeitraum: Voreinstellungen, eigen und ungültig', () => {
  const heute = '2026-11-07';
  assert.deepEqual(parseZeitraum({}, heute), { art: 'jahr', von: '2026-01-01', bis: '2026-11-07', budgetJahr: 2026 });
  assert.deepEqual(parseZeitraum({ zeitraum: '12m' }, heute), { art: '12m', von: '2025-11-07', bis: '2026-11-07', budgetJahr: 2026 });
  assert.deepEqual(parseZeitraum({ zeitraum: 'vorjahr' }, heute), { art: 'vorjahr', von: '2025-01-01', bis: '2025-12-31', budgetJahr: 2025 });
  assert.deepEqual(parseZeitraum({ zeitraum: 'eigen', von: '2024-06-01', bis: '2025-02-28' }, heute), { art: 'eigen', von: '2024-06-01', bis: '2025-02-28', budgetJahr: 2025 });
  for (const q of [{ zeitraum: 'eigen', von: '2025-03-01', bis: '2025-02-01' }, { zeitraum: 'eigen', von: '2025-02-30', bis: '2025-03-01' }, { zeitraum: 'eigen', von: '2019-01-01', bis: '2025-01-02' }, { zeitraum: 'quatsch' }, { zeitraum: 'eigen', von: 'x' }]) {
    const r = parseZeitraum(q, heute);
    assert.ok(r.fehler, JSON.stringify(q));
    assert.equal(r.art, 'jahr');
    assert.equal(r.von, '2026-01-01');
  }
});

test('formatChf und parseBetrag', () => {
  assert.equal(formatChf(12345.6), "CHF 12'345.60");
  assert.equal(formatChf(-30), 'CHF -30.00');
  assert.equal(formatChf(0), 'CHF 0.00');
  assert.equal(formatChf(1234567.891), "CHF 1'234'567.89");
  assert.equal(parseBetrag("12'000.–"), 12000);
  assert.equal(parseBetrag('12 000,50'), 12000.5);
  assert.equal(parseBetrag('1500'), 1500);
  assert.equal(parseBetrag('CHF 2’500.25'), 2500.25);
  assert.equal(parseBetrag('abc'), null);
  assert.equal(parseBetrag(''), null);
  assert.equal(parseBetrag('-5'), null);
  assert.equal(parseBetrag('1.2.3'), null);
});

test('Ausschöpfung wie im Entwurf: (freigegeben + in Freigabe) / Budget, über Budget auch durch offene Rechnungen', () => {
  const { db, a } = setup();
  job(db, { konto_id: a, betrag: '80' });
  job(db, { konto_id: a, betrag: '40', status: 'freigabe2' });
  setzeBudget(db, { kontoId: a, jahr: 2026, betrag: 100, personId: '9' });
  const za = budgetProKonto(db, { ...JAHR, budgetJahr: 2026, kontoIds: null }).find((z) => z.kontoId === a);
  assert.equal(za.ausschoepfung, 1.2);
  assert.equal(za.ueberBudget, true);
  db.close();
});
