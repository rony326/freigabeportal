import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { seedDefaults } from '../../src/db/adminConfigRepo.js';
import { erstelleAuditExportPaket } from '../../src/services/auditExport.js';
import { stempleAuditPaket } from '../../src/services/auditZeitstempel.js';
import { formatierePruefnummer } from '../../src/services/auditNachweisJobs.js';
import { kanonischesJson } from '../../src/services/tsaNachweis.js';
import { normalisierePruefnummer, pruefeAuditNachweis } from '../../src/services/auditPruefung.js';
import { setupMockTsa } from '../helpers/mockTsa.js';
import { createChainedTsa } from '../helpers/chainedTsa.js';

const TSA_URL = 'https://tsa.example.org/tsr';
const TAG = 24 * 3600 * 1000;

function ereignis(db, personName = 'System') {
  db.prepare(`INSERT INTO audit_ereignisse (zeitpunkt, person_id, person_name, objekt, objekt_id, aktion, nachher)
    VALUES ('2026-09-29T00:00:00Z', 'system', ?, 'test', '1', 'test', '{}')`).run(personName);
}

function setup(t) {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  seedDefaults(db);
  return db;
}

function tsaVorbereiten(t) {
  const tsa = createChainedTsa(t);
  setupMockTsa(TSA_URL).intercept({ path: '/tsr', method: 'POST' }).reply(200, tsa.reply).persist();
  return { url: TSA_URL, trustAnchorsFile: tsa.rootFile, trustAnchorsSha256: tsa.rootSha256, crlFile: tsa.crlFile };
}

// Echtes Token wie im Job (runAuditExportJob) speichern.
async function stempeln(db, tsaConfig, paket) {
  const { token, genTime, nachweis } = await stempleAuditPaket(paket.paket_sha256, tsaConfig);
  db.prepare(`INSERT INTO audit_export_zeitstempel (paket_nr, token, gen_time, nachweis, erstellt_am)
    VALUES (?, ?, ?, ?, ?)`).run(paket.id, token, genTime.toISOString(), kanonischesJson(nachweis), new Date().toISOString());
}

function paket(db, { jetzt = new Date() } = {}) {
  ereignis(db);
  const p = erstelleAuditExportPaket(db, { jetzt });
  assert.ok(p);
  return db.prepare('SELECT * FROM audit_export_pakete WHERE id = ?').get(p.manifest.paketNr);
}

async function zweiGestempeltePakete(t) {
  const db = setup(t);
  const tsaConfig = tsaVorbereiten(t);
  const p1 = paket(db);
  const p2 = paket(db);
  await stempeln(db, tsaConfig, p1);
  await stempeln(db, tsaConfig, p2);
  return { db, tsaConfig, p1, p2 };
}

test('normalisierePruefnummer: entfernt Leerzeichen und Bindestriche, klein, nur 64 Hex', () => {
  const hex = 'ab'.repeat(32);
  assert.equal(normalisierePruefnummer(hex), hex);
  assert.equal(normalisierePruefnummer(` ${formatierePruefnummer(hex).toUpperCase()}\n`), hex);
  assert.equal(normalisierePruefnummer(hex.match(/.{4}/g).join('-')), hex);
  assert.equal(normalisierePruefnummer('xyz'), null);
  assert.equal(normalisierePruefnummer(hex.slice(2)), null);
  assert.equal(normalisierePruefnummer(`${hex}0`), null);
  assert.equal(normalisierePruefnummer(''), null);
  assert.equal(normalisierePruefnummer(undefined), null);
  assert.equal(normalisierePruefnummer(['a']), null);
});

test('richtige Prüfnummer, Kette intakt, alle gestempelt → ok', async (t) => {
  const { db, p1 } = await zweiGestempeltePakete(t);
  const ergebnis = await pruefeAuditNachweis(db, { paketNr: p1.id, pruefnummer: p1.paket_sha256 });
  assert.equal(ergebnis.status, 'ok', JSON.stringify(ergebnis.punkte));
  assert.equal(ergebnis.punkte.length, 3);
  assert.ok(ergebnis.punkte.every((p) => p.ok));
  assert.deepEqual(ergebnis.neuere, { anzahl: 1, alleGestempelt: true });
});

test('normalisiert Prüfnummer', async (t) => {
  const { db, p2 } = await zweiGestempeltePakete(t);
  const eingabe = `${formatierePruefnummer(p2.paket_sha256).toUpperCase()}\n`;
  const ergebnis = await pruefeAuditNachweis(db, { paketNr: p2.id, pruefnummer: eingabe });
  assert.equal(ergebnis.status, 'ok', JSON.stringify(ergebnis.punkte));
  assert.deepEqual(ergebnis.neuere, { anzahl: 0, alleGestempelt: true });
});

test('falsche Prüfnummer → abweichung, Punkt 1 rot', async (t) => {
  const { db, p1, p2 } = await zweiGestempeltePakete(t);
  const ergebnis = await pruefeAuditNachweis(db, { paketNr: p1.id, pruefnummer: p2.paket_sha256 });
  assert.equal(ergebnis.status, 'abweichung');
  assert.equal(ergebnis.punkte[0].ok, false);
  assert.equal(ergebnis.punkte[1].ok, true);
  assert.equal(ergebnis.punkte[2].ok, true);
});

test('Audit-Ereignis nachträglich verändert → abweichung, Punkt 2 rot', async (t) => {
  const { db, p1 } = await zweiGestempeltePakete(t);
  db.exec('DROP TRIGGER audit_no_update');
  db.prepare("UPDATE audit_ereignisse SET aktion = 'gefaelscht' WHERE id = ?").run(p1.von_id);
  const ergebnis = await pruefeAuditNachweis(db, { paketNr: p1.id, pruefnummer: p1.paket_sha256 });
  assert.equal(ergebnis.status, 'abweichung');
  assert.equal(ergebnis.punkte[0].ok, true);
  assert.equal(ergebnis.punkte[1].ok, false);
  assert.match(ergebnis.punkte[1].text, /Paket 1/);
  assert.match(ergebnis.punkte[1].text, /Inhalt/);
});

test('Paket ohne Zeitstempel → abweichung, Punkt 3 rot, Text nennt Paketnummer', async (t) => {
  const db = setup(t);
  const tsaConfig = tsaVorbereiten(t);
  const p1 = paket(db);
  const p2 = paket(db);
  await stempeln(db, tsaConfig, p2);
  const ergebnis = await pruefeAuditNachweis(db, { paketNr: p2.id, pruefnummer: p2.paket_sha256 });
  assert.equal(ergebnis.status, 'abweichung');
  assert.equal(ergebnis.punkte[0].ok, true);
  assert.equal(ergebnis.punkte[1].ok, true);
  assert.equal(ergebnis.punkte[2].ok, false);
  assert.match(ergebnis.punkte[2].text, new RegExp(`Paket ${p1.id}\\b`));
});

test('ohne Zeitstempel-Konfiguration nennt Punkt 3 das ausdrücklich', async (t) => {
  const db = setup(t);
  const p1 = paket(db);
  const ergebnis = await pruefeAuditNachweis(db, { paketNr: p1.id, pruefnummer: p1.paket_sha256 });
  assert.equal(ergebnis.status, 'abweichung');
  assert.equal(ergebnis.punkte[2].ok, false);
  assert.match(ergebnis.punkte[2].text, /kein Zeitstempeldienst konfiguriert/i);
});

test('Zeitstempel verspätet (> 7 Tage nach Erstellung) → Punkt 3 rot mit "verspätet"', async (t) => {
  const db = setup(t);
  const tsaConfig = tsaVorbereiten(t);
  const p1 = paket(db, { jetzt: new Date(Date.now() - 8 * TAG) });
  await stempeln(db, tsaConfig, p1);
  const ergebnis = await pruefeAuditNachweis(db, { paketNr: p1.id, pruefnummer: p1.paket_sha256 });
  assert.equal(ergebnis.status, 'abweichung');
  assert.equal(ergebnis.punkte[2].ok, false);
  assert.match(ergebnis.punkte[2].text, /verspätet/);
  assert.match(ergebnis.punkte[2].text, /Paket 1/);
});

test('Zeitstempel vor der Erstellung des Pakets → Punkt 3 rot', async (t) => {
  const db = setup(t);
  const tsaConfig = tsaVorbereiten(t);
  const p1 = paket(db, { jetzt: new Date(Date.now() + 10 * 60 * 1000) });
  await stempeln(db, tsaConfig, p1);
  const ergebnis = await pruefeAuditNachweis(db, { paketNr: p1.id, pruefnummer: p1.paket_sha256 });
  assert.equal(ergebnis.punkte[2].ok, false);
  assert.match(ergebnis.punkte[2].text, /vor der Erstellung/);
});

test('Zeitstempel eines anderen Pakets (Stub-Token) → Punkt 3 rot "ungültig"', async (t) => {
  const db = setup(t);
  const p1 = paket(db);
  db.prepare(`INSERT INTO audit_export_zeitstempel (paket_nr, token, gen_time, nachweis, erstellt_am)
    VALUES (?, ?, ?, '{}', ?)`).run(p1.id, Buffer.from('kein token'), new Date().toISOString(), new Date().toISOString());
  const ergebnis = await pruefeAuditNachweis(db, { paketNr: p1.id, pruefnummer: p1.paket_sha256 });
  assert.equal(ergebnis.punkte[2].ok, false);
  assert.match(ergebnis.punkte[2].text, /ungültig/);
  assert.doesNotMatch(ergebnis.punkte[2].text, /ungueltig|Pruefnummer/);
});

test('neuere Pakete ohne Zeitstempel: Ergebnis bleibt ok, neuere meldet es', async (t) => {
  const db = setup(t);
  const tsaConfig = tsaVorbereiten(t);
  const p1 = paket(db);
  await stempeln(db, tsaConfig, p1);
  paket(db);
  const ergebnis = await pruefeAuditNachweis(db, { paketNr: p1.id, pruefnummer: p1.paket_sha256 });
  assert.equal(ergebnis.status, 'ok');
  assert.deepEqual(ergebnis.neuere, { anzahl: 1, alleGestempelt: false });
});

test('unbekannte Paketnummer → unbekannt; noch kein Paket → kein_paket', async (t) => {
  const leer = setup(t);
  const hex = 'ab'.repeat(32);
  assert.equal((await pruefeAuditNachweis(leer, { paketNr: 1, pruefnummer: hex })).status, 'kein_paket');
  const db = setup(t);
  paket(db);
  const ergebnis = await pruefeAuditNachweis(db, { paketNr: 99, pruefnummer: hex });
  assert.equal(ergebnis.status, 'unbekannt');
  assert.deepEqual(ergebnis.punkte, []);
});

test('Ergebnis enthält keine Personendaten aus dem Audit-Log', async (t) => {
  const db = setup(t);
  ereignis(db, 'Erika Mustermann');
  db.exec('DROP TRIGGER audit_no_update');
  const p1 = paket(db);
  db.prepare("UPDATE audit_ereignisse SET aktion = 'x' WHERE id = ?").run(p1.von_id);
  const ergebnis = await pruefeAuditNachweis(db, { paketNr: p1.id, pruefnummer: p1.paket_sha256 });
  assert.doesNotMatch(JSON.stringify(ergebnis), /Mustermann/);
});
