import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { getKreditorById, createKreditor, updateKreditor } from '../../src/db/kreditorenRepo.js';
import { createKreditorIban } from '../../src/db/kreditorIbanRepo.js';
import { createFreigabe } from '../../src/db/freigabenRepo.js';
import { setConfigValue } from '../../src/db/adminConfigRepo.js';
import { kreditorMitIban, kreditorOhneIbanPflicht } from '../helpers/kreditor.js';
import {
  ermittleBefunde,
  ibanBefund,
  befundeHash,
  brauchtManuelleIbanPruefung,
  ibanEndungPasst,
  normalisiereFirmenname,
  namenPassen,
  FRUEHERE_RECHNUNGEN_AUSGESCHLOSSENE_STATUS,
} from '../../src/services/betrugspruefung.js';

const IBAN_HINTERLEGT = 'CH9300762011623852957';
const IBAN_ANDERE = 'CH4431999123000889012';
const IBAN_UNBEKANNT = 'CH5604835012345678009';
const TAG = 24 * 60 * 60 * 1000;

function setup() {
  const db = openDatabase(':memory:');
  db.prepare("INSERT INTO personen (churchtools_person_id, vorname, nachname, email) VALUES ('1', 'Fritz', 'Freigeber', 'f@example.ch')").run();
  return db;
}

function job(db, felder = {}) {
  const werte = {
    eingang_am: new Date().toISOString(), quelle: 'lieferant', dateiname: 'r.pdf', pdf_pfad: '/tmp/r.pdf', status: 'zugewiesen', ...felder,
  };
  const spalten = Object.keys(werte);
  const id = Number(db.prepare(`INSERT INTO jobs (${spalten.join(', ')}) VALUES (${spalten.map(() => '?').join(', ')})`).run(...Object.values(werte)).lastInsertRowid);
  return db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
}

// Früher kontierte Rechnung mit Freigabe 1 vor `tageZurueck` Tagen.
function fruehereRechnung(db, kreditorId, betrag, { tageZurueck = 20, rechnungsnummer = null, status = 'abgeschlossen', typ = 'rechnung' } = {}) {
  const j = job(db, { kreditor_id: kreditorId, betrag, status, typ, rechnungsnummer });
  createFreigabe(db, { jobId: j.id, personId: '1', rolle: 'freigeber1', zeitpunkt: new Date(Date.now() - tageZurueck * TAG).toISOString(), ip: '127.0.0.1', interessenskonflikt: false });
  return j;
}

const codes = (befunde) => befunde.map((b) => b.code);

test('QR-IBAN bei anderem Kreditor hinterlegt → genau iban_anderer_kreditor (rot), kein iban_fremd', () => {
  const db = setup();
  const k = getKreditorById(db, kreditorMitIban(db, { name: 'Muster Druck AG' }));
  kreditorMitIban(db, { name: 'Fremd GmbH', iban: IBAN_ANDERE });
  const j = job(db, { qr_iban: IBAN_ANDERE });
  const befunde = ermittleBefunde(db, { job: j, kreditor: k, betrag: '100', typ: 'rechnung' });
  assert.deepEqual(codes(befunde), ['iban_anderer_kreditor']);
  assert.equal(befunde[0].schwere, 'rot');
  assert.equal(befunde[0].titel, 'IBAN gehört einem anderen Lieferanten');
  assert.equal(befunde[0].text, 'Die IBAN auf der Rechnung (CH44 … 9012) ist bei «Fremd GmbH» hinterlegt, nicht bei «Muster Druck AG».');
});

test('QR-IBAN unbekannt → iban_fremd; hinterlegt → kein IBAN-Befund', () => {
  const db = setup();
  const k = getKreditorById(db, kreditorMitIban(db, { name: 'Muster Druck AG' }));
  const fremd = ermittleBefunde(db, { job: job(db, { qr_iban: IBAN_UNBEKANNT }), kreditor: k, betrag: '100', typ: 'rechnung' });
  assert.deepEqual(codes(fremd), ['iban_fremd']);
  assert.equal(fremd[0].schwere, 'rot');
  assert.equal(fremd[0].titel, 'IBAN nicht hinterlegt');
  assert.equal(fremd[0].text, 'Die IBAN auf der Rechnung (CH56 … 8009) stimmt mit keiner hinterlegten IBAN von «Muster Druck AG» überein.');
  const ok = ermittleBefunde(db, { job: job(db, { qr_iban: 'ch93 0076 2011 6238 5295 7' }), kreditor: k, betrag: '100', typ: 'rechnung' });
  assert.deepEqual(codes(ok), []);
});

test('Dauerauftrag-Kreditor bekommt die volle IBAN-Prüfung', () => {
  const db = setup();
  const k = getKreditorById(db, kreditorMitIban(db, { name: 'Miete AG', zahlungsart: 'dauerauftrag' }));
  const befunde = ermittleBefunde(db, { job: job(db, { qr_iban: IBAN_UNBEKANNT }), kreditor: k, betrag: '100', typ: 'rechnung' });
  assert.deepEqual(codes(befunde), ['iban_fremd']);
});

test('lastschrift-Kreditor + QR → nur zahlungsart_ohne_iban', () => {
  const db = setup();
  const k = getKreditorById(db, kreditorOhneIbanPflicht(db, { name: 'Karten AG' }));
  const befunde = ermittleBefunde(db, { job: job(db, { qr_iban: IBAN_UNBEKANNT }), kreditor: k, betrag: '100', typ: 'rechnung' });
  assert.deepEqual(codes(befunde), ['zahlungsart_ohne_iban']);
  assert.equal(befunde[0].schwere, 'gelb');
  assert.equal(befunde[0].titel, 'Lieferant wird sonst per Lastschrift bezahlt');
  assert.equal(befunde[0].text, 'Diese Rechnung hat einen Einzahlungsschein, «Karten AG» wird aber per Lastschrift bezahlt.');
});

test('kreditkarte-Kreditor + QR → zahlungsart_ohne_iban mit Label Kreditkarte, auch bei Gutschrift', () => {
  const db = setup();
  const k = getKreditorById(db, createKreditor(db, { name: 'Karte AG', zahlungsart: 'kreditkarte' }));
  const befunde = ermittleBefunde(db, { job: job(db, { qr_iban: IBAN_HINTERLEGT }), kreditor: k, betrag: '100', typ: 'gutschrift' });
  assert.deepEqual(codes(befunde), ['zahlungsart_ohne_iban']);
  assert.equal(befunde[0].titel, 'Lieferant wird sonst per Kreditkarte bezahlt');
});

test('iban_manuell_fremd nur mit übergebener Endung, die zu keiner IBAN passt', () => {
  const db = setup();
  const k = getKreditorById(db, kreditorMitIban(db, { name: 'Muster Druck AG' }));
  const j = job(db);
  assert.deepEqual(codes(ermittleBefunde(db, { job: j, kreditor: k, betrag: '100', typ: 'rechnung' })), []);
  assert.deepEqual(codes(ermittleBefunde(db, { job: j, kreditor: k, betrag: '100', typ: 'rechnung', ibanEndung: '2957' })), []);
  const befunde = ermittleBefunde(db, { job: j, kreditor: k, betrag: '100', typ: 'rechnung', ibanEndung: ' 1234 ' });
  assert.deepEqual(codes(befunde), ['iban_manuell_fremd']);
  assert.equal(befunde[0].schwere, 'rot');
  assert.equal(befunde[0].titel, 'IBAN nicht hinterlegt (manuelle Prüfung)');
  assert.equal(befunde[0].text, 'Die letzten 4 Zeichen (1234) passen zu keiner hinterlegten IBAN von «Muster Druck AG».');
});

test('brauchtManuelleIbanPruefung: nur ohne QR, Typ Rechnung, IBAN-Pflicht-Zahlungsart', () => {
  const ueberweisung = { zahlungsart: 'ueberweisung' };
  assert.equal(brauchtManuelleIbanPruefung({ qr_iban: null }, ueberweisung, 'rechnung'), true);
  assert.equal(brauchtManuelleIbanPruefung({ qr_iban: null }, { zahlungsart: 'dauerauftrag' }, 'rechnung'), true);
  assert.equal(brauchtManuelleIbanPruefung({ qr_iban: IBAN_HINTERLEGT }, ueberweisung, 'rechnung'), false);
  assert.equal(brauchtManuelleIbanPruefung({ qr_iban: null }, ueberweisung, 'gutschrift'), false);
  assert.equal(brauchtManuelleIbanPruefung({ qr_iban: null }, { zahlungsart: 'lastschrift' }, 'rechnung'), false);
  assert.equal(brauchtManuelleIbanPruefung({ qr_iban: null }, { zahlungsart: 'kreditkarte' }, 'rechnung'), false);
});

test('normalisiereFirmenname entfernt Rechtsformen, Umlaute, Satzzeichen', () => {
  assert.equal(normalisiereFirmenname('Muster Druck AG'), 'musterdruck');
  assert.equal(normalisiereFirmenname('MUSTER-DRUCK'), 'musterdruck');
  assert.equal(normalisiereFirmenname('Café Crème Sàrl'), 'cafecreme');
  assert.equal(normalisiereFirmenname('Turnverein Musterstadt e.V.'), 'turnvereinmusterstadt');
  assert.equal(normalisiereFirmenname('Grosse Strasse GmbH'), normalisiereFirmenname('Große Straße GmbH'));
  assert.equal(normalisiereFirmenname('Müller & Co. KG'), 'muller');
});

test('namenPassen: festgelegte Grenzfälle', () => {
  assert.equal(namenPassen('Muster Druck AG', 'MUSTER-DRUCK'), true);
  assert.equal(namenPassen('Muster Druck AG', 'Muster Druk GmbH'), false);
  // Festgehalten (Regel nicht dafür angepasst): «&» vs. «und» bleibt eine Abweichung.
  assert.equal(namenPassen('Müller & Söhne GmbH', 'Mueller und Soehne'), false);
  assert.equal(namenPassen('Müller Söhne GmbH', 'Mueller Soehne'), true);
  assert.equal(namenPassen('Gebäudereinigung Blitz GmbH', 'Gebaudereinigung Blitz'), true);
  assert.equal(namenPassen('Blitz', 'Gebäudereinigung Blitz AG'), true);
  assert.equal(namenPassen('AG', 'Muster Druck AG'), false);
});

test('name-Befund nur mit qr_creditor_name, Text nennt beide Namen', () => {
  const db = setup();
  const k = getKreditorById(db, kreditorMitIban(db, { name: 'Muster Druck AG' }));
  const befunde = ermittleBefunde(db, { job: job(db, { qr_iban: IBAN_HINTERLEGT, qr_creditor_name: 'Muster Druk GmbH' }), kreditor: k, betrag: '100', typ: 'rechnung' });
  assert.deepEqual(codes(befunde), ['name']);
  assert.equal(befunde[0].titel, 'Name weicht ab');
  assert.equal(befunde[0].text, 'Zahlungsempfänger im QR-Code: «Muster Druk GmbH» · Lieferant: «Muster Druck AG»');
  assert.deepEqual(codes(ermittleBefunde(db, { job: job(db, { qr_iban: IBAN_HINTERLEGT, qr_creditor_name: 'MUSTER-DRUCK' }), kreditor: k, betrag: '100', typ: 'rechnung' })), []);
});

test('betrag_qr: auf Rappen genau, Komma erlaubt', () => {
  const db = setup();
  const k = getKreditorById(db, kreditorMitIban(db, { name: 'Muster Druck AG' }));
  // Neuer Lieferant mit 4780 löst zusätzlich neuer_kreditor aus — hier zählt nur betrag_qr.
  const qr = (felder, betrag) => ermittleBefunde(db, { job: job(db, { qr_iban: IBAN_HINTERLEGT, ...felder }), kreditor: k, betrag, typ: 'rechnung' })
    .filter((b) => b.code === 'betrag_qr');
  const befunde = qr({ qr_betrag: '4870.00' }, '4780');
  assert.equal(befunde.length, 1);
  assert.equal(befunde[0].schwere, 'gelb');
  assert.equal(befunde[0].titel, 'Betrag weicht ab');
  assert.equal(befunde[0].text, "QR-Code: CHF 4'870.00 · kontiert: CHF 4'780.00");
  assert.deepEqual(qr({ qr_betrag: '4780.00' }, '4780'), []);
  assert.deepEqual(qr({ qr_betrag: '4780.50' }, '4780,5'), []);
  assert.deepEqual(qr({}, '4780'), []);
});

test('betrag_qr entfällt bei einem Splitkind: der QR-Betrag gilt für die ganze Rechnung, nicht für den Teilbetrag', () => {
  const db = setup();
  const k = getKreditorById(db, kreditorMitIban(db, { name: 'Muster Druck AG' }));
  const eltern = job(db, { qr_iban: IBAN_HINTERLEGT, qr_betrag: '200.00', status: 'aufgesplittet' });
  const kind = job(db, { qr_iban: IBAN_HINTERLEGT, qr_betrag: '200.00', aufgesplittet_von: eltern.id });
  const befunde = ermittleBefunde(db, { job: kind, kreditor: k, betrag: '80.00', typ: 'rechnung' });
  assert.deepEqual(codes(befunde).filter((c) => c === 'betrag_qr'), []);
});

test('betrag_qr nutzt die QR-Währung im Text', () => {
  const db = setup();
  const k = getKreditorById(db, kreditorMitIban(db, { name: 'Muster Druck AG' }));
  const befunde = ermittleBefunde(db, { job: job(db, { qr_iban: IBAN_HINTERLEGT, qr_betrag: '1234567.5', qr_waehrung: 'EUR' }), kreditor: k, betrag: '100', typ: 'rechnung' });
  assert.equal(befunde[0].text, "QR-Code: EUR 1'234'567.50 · kontiert: EUR 100.00");
});

test('E betrag_hoch: 5 frühere à 950 → Befund mit Text', () => {
  const db = setup();
  const kid = kreditorMitIban(db, { name: 'Muster Druck AG' });
  for (let i = 0; i < 5; i += 1) fruehereRechnung(db, kid, '950.00', { rechnungsnummer: `R${i}`, tageZurueck: 60 + i });
  const befunde = ermittleBefunde(db, { job: job(db, { kreditor_id: kid }), kreditor: getKreditorById(db, kid), betrag: '4780', typ: 'rechnung' });
  assert.deepEqual(codes(befunde), ['betrag_hoch']);
  assert.equal(befunde[0].schwere, 'gelb');
  assert.equal(befunde[0].titel, 'Ungewöhnlich hoher Betrag');
  assert.equal(befunde[0].text, "5-mal so hoch wie der Durchschnitt der letzten 5 Rechnungen (CHF 950.00)");
});

test('E: 4 frühere → kein Befund; unter Mindestbetrag → kein Befund', () => {
  const db = setup();
  const kid = kreditorMitIban(db, { name: 'Muster Druck AG' });
  for (let i = 0; i < 4; i += 1) fruehereRechnung(db, kid, '950.00', { tageZurueck: 60 + i });
  assert.deepEqual(codes(ermittleBefunde(db, { job: job(db), kreditor: getKreditorById(db, kid), betrag: '4780', typ: 'rechnung' })), []);

  const kid2 = kreditorMitIban(db, { name: 'Klein AG', iban: IBAN_ANDERE });
  for (let i = 0; i < 5; i += 1) fruehereRechnung(db, kid2, '100.00', { tageZurueck: 60 + i });
  assert.deepEqual(codes(ermittleBefunde(db, { job: job(db), kreditor: getKreditorById(db, kid2), betrag: '400', typ: 'rechnung' })), []);
});

test('E: betrag_schwankt=1 → kein Befund; Gutschrift → kein Befund', () => {
  const db = setup();
  const kid = kreditorMitIban(db, { name: 'Muster Druck AG' });
  for (let i = 0; i < 5; i += 1) fruehereRechnung(db, kid, '950.00', { tageZurueck: 60 + i });
  assert.deepEqual(codes(ermittleBefunde(db, { job: job(db), kreditor: getKreditorById(db, kid), betrag: '4780', typ: 'gutschrift' })), []);
  updateKreditor(db, kid, { name: 'Muster Druck AG', kontoId: null, betragSchwankt: true });
  assert.deepEqual(codes(ermittleBefunde(db, { job: job(db), kreditor: getKreditorById(db, kid), betrag: '4780', typ: 'rechnung' })), []);
});

test('E: Durchschnitt über die letzten 12 Monate, wenn dort genug Rechnungen liegen', () => {
  const db = setup();
  const kid = kreditorMitIban(db, { name: 'Muster Druck AG' });
  for (let i = 0; i < 5; i += 1) fruehereRechnung(db, kid, '950.00', { tageZurueck: 60 + i });
  for (let i = 0; i < 3; i += 1) fruehereRechnung(db, kid, '10000.00', { tageZurueck: 400 + i });
  const befunde = ermittleBefunde(db, { job: job(db), kreditor: getKreditorById(db, kid), betrag: '4780', typ: 'rechnung' });
  assert.deepEqual(codes(befunde), ['betrag_hoch']);
  assert.match(befunde[0].text, /letzten 5 Rechnungen \(CHF 950\.00\)/);
});

test('E: zu wenige in 12 Monaten → Durchschnitt über alle', () => {
  const db = setup();
  const kid = kreditorMitIban(db, { name: 'Muster Druck AG' });
  for (let i = 0; i < 2; i += 1) fruehereRechnung(db, kid, '1000.00', { tageZurueck: 60 + i });
  for (let i = 0; i < 4; i += 1) fruehereRechnung(db, kid, '1000.00', { tageZurueck: 400 + i });
  const befunde = ermittleBefunde(db, { job: job(db), kreditor: getKreditorById(db, kid), betrag: '3000', typ: 'rechnung' });
  assert.deepEqual(codes(befunde), ['betrag_hoch']);
  assert.equal(befunde[0].text, "3-mal so hoch wie der Durchschnitt der letzten 6 Rechnungen (CHF 1'000.00)");
});

test('F neuer_kreditor: Grenze > 2000', () => {
  const db = setup();
  const k = getKreditorById(db, kreditorMitIban(db, { name: 'Neu AG' }));
  assert.deepEqual(codes(ermittleBefunde(db, { job: job(db), kreditor: k, betrag: '2000.00', typ: 'rechnung' })), []);
  const befunde = ermittleBefunde(db, { job: job(db), kreditor: k, betrag: '2000.05', typ: 'rechnung' });
  assert.deepEqual(codes(befunde), ['neuer_kreditor']);
  assert.equal(befunde[0].titel, 'Neuer Lieferant, hoher Betrag');
  assert.equal(befunde[0].text, "Erste Rechnung von «Neu AG» über CHF 2'000.05.");
  assert.deepEqual(codes(ermittleBefunde(db, { job: job(db), kreditor: k, betrag: '2000.05', typ: 'gutschrift' })), []);
});

test('F: eine frühere kontierte Rechnung reicht, damit kein neuer_kreditor kommt', () => {
  const db = setup();
  const kid = kreditorMitIban(db, { name: 'Alt AG' });
  fruehereRechnung(db, kid, '5000.00', { tageZurueck: 500 });
  assert.deepEqual(codes(ermittleBefunde(db, { job: job(db), kreditor: getKreditorById(db, kid), betrag: '3000', typ: 'rechnung' })), []);
});

test('G gleicher_betrag: vor 10 Tagen → Befund, vor 31 Tagen → keiner', () => {
  const db = setup();
  const kid = kreditorMitIban(db, { name: 'Muster Druck AG' });
  const frueher = fruehereRechnung(db, kid, '480.00', { tageZurueck: 10, rechnungsnummer: 'A-1' });
  const befunde = ermittleBefunde(db, { job: job(db, { rechnungsnummer: 'A-2' }), kreditor: getKreditorById(db, kid), betrag: '480', typ: 'rechnung' });
  assert.deepEqual(codes(befunde), ['gleicher_betrag']);
  assert.equal(befunde[0].titel, 'Gleicher Betrag kurz hintereinander');
  const datum = new Intl.DateTimeFormat('de-CH', { timeZone: 'Europe/Zurich', day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(Date.now() - 10 * TAG));
  assert.equal(befunde[0].text, `Gleicher Betrag wie Rechnung #${frueher.id} vom ${datum} (innerhalb von 30 Tagen).`);

  const kid2 = kreditorMitIban(db, { name: 'Alt AG', iban: IBAN_ANDERE });
  fruehereRechnung(db, kid2, '480.00', { tageZurueck: 31, rechnungsnummer: 'A-1' });
  assert.deepEqual(codes(ermittleBefunde(db, { job: job(db, { rechnungsnummer: 'A-2' }), kreditor: getKreditorById(db, kid2), betrag: '480', typ: 'rechnung' })), []);
});

test('G: gleiche Rechnungsnummer → kein Befund (eigener Duplikat-Check); übergebene Nummer hat Vorrang', () => {
  const db = setup();
  const kid = kreditorMitIban(db, { name: 'Muster Druck AG' });
  fruehereRechnung(db, kid, '480.00', { tageZurueck: 10, rechnungsnummer: 'A-1' });
  const k = getKreditorById(db, kid);
  assert.deepEqual(codes(ermittleBefunde(db, { job: job(db, { rechnungsnummer: 'A-1' }), kreditor: k, betrag: '480', typ: 'rechnung' })), []);
  assert.deepEqual(codes(ermittleBefunde(db, { job: job(db, { rechnungsnummer: 'A-2' }), kreditor: k, betrag: '480', typ: 'rechnung', rechnungsnummer: 'A-1' })), []);
  assert.deepEqual(codes(ermittleBefunde(db, { job: job(db), kreditor: k, betrag: '480', typ: 'rechnung' })), ['gleicher_betrag']);
});

test('G: nicht bei dauerauftrag und lastschrift', () => {
  const db = setup();
  const kid = kreditorMitIban(db, { name: 'Miete AG', zahlungsart: 'dauerauftrag' });
  fruehereRechnung(db, kid, '480.00', { tageZurueck: 10, rechnungsnummer: 'A-1' });
  assert.deepEqual(codes(ermittleBefunde(db, { job: job(db, { rechnungsnummer: 'A-2' }), kreditor: getKreditorById(db, kid), betrag: '480', typ: 'rechnung' })), []);
  const kid2 = kreditorOhneIbanPflicht(db, { name: 'LSV AG' });
  fruehereRechnung(db, kid2, '480.00', { tageZurueck: 10, rechnungsnummer: 'A-1' });
  assert.deepEqual(codes(ermittleBefunde(db, { job: job(db, { rechnungsnummer: 'A-2' }), kreditor: getKreditorById(db, kid2), betrag: '480', typ: 'rechnung' })), []);
});

test('Frühere kontierte Rechnungen: Status-Liste festgehalten', () => {
  assert.deepEqual([...FRUEHERE_RECHNUNGEN_AUSGESCHLOSSENE_STATUS].sort(), ['abgelehnt', 'aufgesplittet', 'geloescht', 'unzugewiesen', 'zugewiesen']);
  const db = setup();
  const kid = kreditorMitIban(db, { name: 'Muster Druck AG' });
  const k = getKreditorById(db, kid);
  const zaehlt = ['kontiert', 'freigabe1', 'freigabe2', 'abgeschlossen', 'abgeholt', 'archiviert'];
  const zaehltNicht = ['unzugewiesen', 'zugewiesen', 'abgelehnt', 'aufgesplittet', 'geloescht'];
  for (const status of zaehltNicht) fruehereRechnung(db, kid, '480.00', { status, tageZurueck: 400 });
  // kenntnisnahme gibt es nur für Rapporte (typ 'rapport') — fällt über den Typ-Filter raus.
  fruehereRechnung(db, kid, '480.00', { status: 'kenntnisnahme', typ: 'rapport', tageZurueck: 400 });
  fruehereRechnung(db, kid, '480.00', { status: 'abgeschlossen', typ: 'gutschrift', tageZurueck: 400 });
  assert.deepEqual(codes(ermittleBefunde(db, { job: job(db), kreditor: k, betrag: '2500', typ: 'rechnung' })), ['neuer_kreditor']);
  for (const status of zaehlt) {
    const kidN = createKreditor(db, { name: `K ${status}`, zahlungsart: 'lastschrift' });
    fruehereRechnung(db, kidN, '480.00', { status, tageZurueck: 400 });
    assert.deepEqual(codes(ermittleBefunde(db, { job: job(db), kreditor: getKreditorById(db, kidN), betrag: '2500', typ: 'rechnung' })), [], status);
  }
  // typ NULL (Altbestand) zählt als Rechnung.
  const kidAlt = createKreditor(db, { name: 'Altbestand', zahlungsart: 'lastschrift' });
  fruehereRechnung(db, kidAlt, '480.00', { typ: null, tageZurueck: 400 });
  assert.deepEqual(codes(ermittleBefunde(db, { job: job(db), kreditor: getKreditorById(db, kidAlt), betrag: '2500', typ: 'rechnung' })), []);
});

test('Der aktuelle Job zählt nicht als frühere Rechnung', () => {
  const db = setup();
  const kid = kreditorMitIban(db, { name: 'Muster Druck AG' });
  const aktuell = fruehereRechnung(db, kid, '2500.00', { status: 'abgelehnt', tageZurueck: 1 });
  db.prepare("UPDATE jobs SET status = 'freigabe2' WHERE id = ?").run(aktuell.id);
  const j = db.prepare('SELECT * FROM jobs WHERE id = ?').get(aktuell.id);
  assert.deepEqual(codes(ermittleBefunde(db, { job: j, kreditor: getKreditorById(db, kid), betrag: '2500', typ: 'rechnung' })), ['neuer_kreditor']);
});

test('Sortierung: rot vor gelb, dann Code-Reihenfolge', () => {
  const db = setup();
  const kid = kreditorMitIban(db, { name: 'Muster Druck AG' });
  const k = getKreditorById(db, kid);
  const befunde = ermittleBefunde(db, {
    job: job(db, { qr_iban: IBAN_UNBEKANNT, qr_creditor_name: 'Ganz Anders SA', qr_betrag: '1.00' }), kreditor: k, betrag: '2500', typ: 'rechnung',
  });
  assert.deepEqual(codes(befunde), ['iban_fremd', 'name', 'betrag_qr', 'neuer_kreditor']);
  assert.deepEqual(befunde.map((b) => b.schwere), ['rot', 'gelb', 'gelb', 'gelb']);
});

test('befundeHash: stabil bei gleicher Eingabe, anders bei geändertem Text', () => {
  const a = [{ code: 'name', schwere: 'gelb', titel: 'Name weicht ab', text: 'x' }];
  const b = [{ code: 'name', schwere: 'gelb', titel: 'Anderer Titel', text: 'x' }];
  const c = [{ code: 'name', schwere: 'gelb', titel: 'Name weicht ab', text: 'y' }];
  assert.match(befundeHash(a), /^[0-9a-f]{64}$/);
  assert.equal(befundeHash(a), befundeHash(structuredClone(a)));
  assert.equal(befundeHash(a), befundeHash(b));
  assert.notEqual(befundeHash(a), befundeHash(c));
  assert.notEqual(befundeHash([]), befundeHash(a));
});

test('ibanEndungPasst: normalisiert und vergleicht die letzten 4 Zeichen', () => {
  const db = setup();
  const kid = kreditorMitIban(db, { name: 'Muster Druck AG' });
  assert.equal(ibanEndungPasst(db, kid, ' 2957 '), true);
  assert.equal(ibanEndungPasst(db, kid, '29 57'), true);
  assert.equal(ibanEndungPasst(db, kid, '2958'), false);
  createKreditorIban(db, { kreditorId: kid, iban: 'GB33BUKB20201555ABCD', quelle: 'manuell' });
  assert.equal(ibanEndungPasst(db, kid, 'abcd'), true);
  assert.equal(ibanEndungPasst(db, kid, ''), false);
});

test('Schwellen aus admin_config überschreiben die Defaults', () => {
  const db = setup();
  const kid = kreditorMitIban(db, { name: 'Muster Druck AG' });
  for (let i = 0; i < 5; i += 1) fruehereRechnung(db, kid, '950.00', { tageZurueck: 60 + i });
  setConfigValue(db, 'pruefung_betrag_faktor', '10');
  assert.deepEqual(codes(ermittleBefunde(db, { job: job(db), kreditor: getKreditorById(db, kid), betrag: '4780', typ: 'rechnung' })), []);

  const k2 = getKreditorById(db, kreditorMitIban(db, { name: 'Neu AG', iban: IBAN_ANDERE }));
  setConfigValue(db, 'pruefung_neuer_kreditor_betrag', '5000');
  assert.deepEqual(codes(ermittleBefunde(db, { job: job(db), kreditor: k2, betrag: '4000', typ: 'rechnung' })), []);

  const kid3 = kreditorMitIban(db, { name: 'Drei AG', iban: IBAN_UNBEKANNT });
  fruehereRechnung(db, kid3, '480.00', { tageZurueck: 40, rechnungsnummer: 'A-1' });
  setConfigValue(db, 'pruefung_gleicher_betrag_tage', '45');
  const befunde = ermittleBefunde(db, { job: job(db), kreditor: getKreditorById(db, kid3), betrag: '480', typ: 'rechnung' });
  assert.deepEqual(codes(befunde), ['gleicher_betrag']);
  assert.match(befunde[0].text, /innerhalb von 45 Tagen/);
});

test('Ungültige Schwellen in admin_config fallen auf die Defaults zurück', () => {
  const db = setup();
  const k = getKreditorById(db, kreditorMitIban(db, { name: 'Neu AG' }));
  setConfigValue(db, 'pruefung_neuer_kreditor_betrag', 'abc');
  assert.deepEqual(codes(ermittleBefunde(db, { job: job(db), kreditor: k, betrag: '2000.05', typ: 'rechnung' })), ['neuer_kreditor']);
});

test('Unlesbarer Betrag: keine Betragsprüfungen, kein Fehler', () => {
  const db = setup();
  const k = getKreditorById(db, kreditorMitIban(db, { name: 'Neu AG' }));
  assert.deepEqual(codes(ermittleBefunde(db, { job: job(db, { qr_iban: IBAN_HINTERLEGT, qr_betrag: '5.00' }), kreditor: k, betrag: '', typ: 'rechnung' })), []);
});

test('ibanBefund prüft unabhängig von der Zahlungsart und mit denselben Texten wie ermittleBefunde', () => {
  const db = setup();
  const lastschrift = createKreditor(db, { name: 'Karten Bank', kontoId: null, zahlungsart: 'lastschrift' });
  createKreditorIban(db, { kreditorId: lastschrift, iban: IBAN_HINTERLEGT, quelle: 'manuell' });
  const kreditor = getKreditorById(db, lastschrift);
  assert.equal(ibanBefund(db, kreditor, 'CH93 0076 2011 6238 5295 7'), null, 'normalisiert verglichen');
  const fremd = ibanBefund(db, kreditor, IBAN_UNBEKANNT);
  assert.equal(fremd.code, 'iban_fremd');
  assert.equal(fremd.titel, 'IBAN nicht hinterlegt');
  kreditorMitIban(db, { name: 'Andere AG', iban: IBAN_ANDERE });
  const anderer = ibanBefund(db, kreditor, IBAN_ANDERE);
  assert.equal(anderer.code, 'iban_anderer_kreditor');
  assert.match(anderer.text, /bei «Andere AG» hinterlegt, nicht bei «Karten Bank»/);
  db.close();
});
