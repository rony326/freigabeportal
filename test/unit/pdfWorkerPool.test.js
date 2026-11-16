// B2: Pool der PDF-Worker (services/pdfWorkerPool.js) mit einem Testaufgabenmodul ohne mupdf.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  erstellePdfWorkerPool, PdfWorkerUeberlastet, PdfWorkerZeitueberschreitung, PdfWorkerAbsturz, PdfWorkerNichtVerfuegbar,
} from '../../src/services/pdfWorkerPool.js';
import { erstellePdfArbeit } from '../../src/services/pdfArbeit.js';
import { PdfEingangFehler } from '../../src/services/pdfEingang.js';

const TEST_AUFGABEN = new URL('../helpers/pdfTestAufgaben.js', import.meta.url).href;
const KAPUTT = new URL('../helpers/pdfTestAufgabenKaputt.js', import.meta.url).href;

function stillerLogger() {
  const zeilen = [];
  const merke = (...a) => zeilen.push(a.join(' '));
  return { zeilen, log: merke, warn: merke, error: merke };
}

function pool(optionen = {}) {
  const logger = stillerLogger();
  const p = erstellePdfWorkerPool({ aufgabenModul: TEST_AUFGABEN, logger, ...optionen });
  p.logger = logger;
  return p;
}

test('Pool führt eine Aufgabe aus und liefert das Ergebnis', async () => {
  const p = pool();
  try {
    assert.deepEqual(await p.ausfuehren('echo', [{ a: 1 }]), { a: 1 });
    assert.equal(p.zustand().statistik.erledigt, 1);
  } finally { await p.schliessen(); }
});

test('Zeitlimit: Worker wird ersetzt, der nächste Auftrag klappt', async () => {
  const p = pool({ anzahl: 1, zeitlimits: { blockiere: 300 } });
  try {
    const erster = await p.ausfuehren('threadId');
    const start = Date.now();
    await assert.rejects(p.ausfuehren('blockiere', [20_000]), PdfWorkerZeitueberschreitung);
    assert.ok(Date.now() - start < 5000, 'terminate bricht synchrone Arbeit ab');
    const zweiter = await p.ausfuehren('threadId');
    assert.notEqual(zweiter, erster, 'neuer Worker');
    assert.equal(p.zustand().statistik.zeitueberschreitungen, 1);
  } finally { await p.schliessen(); }
});

test('Zeitlimitfaktor verkürzt die Standardlimits', async () => {
  const p = pool({ anzahl: 1, zeitlimitFaktor: 0.02 }); // 10 s × 0,02 = 200 ms für unbekannte Aufgaben
  try {
    await assert.rejects(p.ausfuehren('blockiere', [5000]), PdfWorkerZeitueberschreitung);
  } finally { await p.schliessen(); }
});

test('Absturz (uncaught im Worker, process.exit): PdfWorkerAbsturz, Pool erholt sich', async () => {
  const p = pool({ anzahl: 1 });
  try {
    await assert.rejects(p.ausfuehren('absturz'), PdfWorkerAbsturz);
    assert.equal(await p.ausfuehren('echo', ['weiter']), 'weiter');
    await assert.rejects(p.ausfuehren('beende'), PdfWorkerAbsturz);
    assert.equal(await p.ausfuehren('echo', ['noch da']), 'noch da');
    assert.equal(p.zustand().statistik.abstuerze, 2);
  } finally { await p.schliessen(); }
});

test('volle Warteschlange → PdfWorkerUeberlastet', async () => {
  const p = pool({ anzahl: 1, maxWarteschlange: 3 });
  try {
    const laufend = [p.ausfuehren('schlafe', [50]), p.ausfuehren('schlafe', [50]), p.ausfuehren('schlafe', [50])];
    await assert.rejects(p.ausfuehren('echo', [1]), PdfWorkerUeberlastet);
    assert.deepEqual(await Promise.all(laufend), ['wach', 'wach', 'wach']);
    assert.equal(p.zustand().statistik.ueberlastet, 1);
  } finally { await p.schliessen(); }
});

test('PdfEingangFehler behält Klasse und code; andere Fehler Name, code und Meldung', async () => {
  const p = pool();
  try {
    await assert.rejects(p.ausfuehren('wirfEingangFehler'), (err) => {
      assert.ok(err instanceof PdfEingangFehler);
      assert.equal(err.code, 'pdf_verschluesselt');
      assert.equal(err.message, 'Testmeldung verschlüsselt');
      return true;
    });
    await assert.rejects(p.ausfuehren('wirfTypFehler'), { name: 'TypeError', code: 'E_TEST', message: 'kaputt' });
    await assert.rejects(p.ausfuehren('gibtEsNicht'), /Unbekannte PDF-Aufgabe/);
  } finally { await p.schliessen(); }
});

test('Buffer des Aufrufers bleibt nutzbar (auch ein kleiner Buffer aus dem gemeinsamen Pool); Ergebnis kommt als Buffer', async () => {
  const p = pool();
  try {
    const klein = Buffer.from('abc');
    const nachbar = Buffer.from('xyz'); // liegt im selben Node-Pool-ArrayBuffer
    const poolGroesse = klein.buffer.byteLength;
    const r = await p.ausfuehren('bytes', [klein]);
    assert.deepEqual({ laenge: r.laenge, istBuffer: r.istBuffer, text: r.text }, { laenge: 3, istBuffer: true, text: 'abc' });
    assert.ok(Buffer.isBuffer(r.kopie));
    assert.equal(r.kopie.toString(), 'abc!');
    assert.equal(klein.toString(), 'abc');
    assert.equal(nachbar.toString(), 'xyz');
    assert.equal(klein.buffer.byteLength, poolGroesse, 'gemeinsamer ArrayBuffer nicht abgelöst');

    const gross = Buffer.alloc(2 * 1024 * 1024, 7);
    const r2 = await p.ausfuehren('bytes', [gross]);
    assert.equal(r2.laenge, gross.length);
    assert.equal(gross.length, 2 * 1024 * 1024);
    assert.equal(gross[gross.length - 1], 7);
  } finally { await p.schliessen(); }
});

test('interaktiv überholt hintergrund; Hintergrund belegt höchstens einen Worker', async () => {
  const p = pool({ anzahl: 1 });
  try {
    await p.ausfuehren('echo', [0]); // Worker warm, sonst wählt der Start schon die interaktive Spur
    const reihenfolge = [];
    const blocker = p.ausfuehren('schlafe', [300], { spur: 'hintergrund' }).then(() => reihenfolge.push('blocker'));
    const hg = p.ausfuehren('echo', ['hg'], { spur: 'hintergrund' }).then((x) => reihenfolge.push(x));
    const ia = p.ausfuehren('echo', ['ia'], { spur: 'interaktiv' }).then((x) => reihenfolge.push(x));
    await Promise.all([blocker, hg, ia]);
    assert.deepEqual(reihenfolge, ['blocker', 'ia', 'hg']);
  } finally { await p.schliessen(); }

  const p2 = pool({ anzahl: 2 });
  try {
    await Promise.all([p2.ausfuehren('echo', [1]), p2.ausfuehren('echo', [2])]); // beide Worker warm
    const start = Date.now();
    const a = p2.ausfuehren('schlafe', [300], { spur: 'hintergrund' });
    const b = p2.ausfuehren('schlafe', [300], { spur: 'hintergrund' });
    assert.equal(p2.zustand().warteschlange.hintergrund, 1, 'zweiter Hintergrundauftrag wartet trotz freiem Worker');
    assert.equal(await p2.ausfuehren('echo', ['frei']), 'frei', 'interaktiv nutzt den zweiten Worker sofort');
    await Promise.all([a, b]);
    assert.ok(Date.now() - start >= 550, 'Hintergrundaufträge liefen nacheinander');
  } finally { await p2.schliessen(); }
});

test('Speichergrenze: Worker wird nach dem Auftrag ersetzt; ebenso nach maxAuftraege', async () => {
  const p = pool({ anzahl: 1, speicherGrenzeMb: 16 });
  try {
    const vorher = await p.ausfuehren('threadId');
    assert.equal(await p.ausfuehren('speicherfresser', [40]), 'gefressen', 'Ergebnis kommt trotzdem an');
    assert.equal(p.zustand().statistik.ersetztSpeicher, 1);
    assert.notEqual(await p.ausfuehren('threadId'), vorher);
  } finally { await p.schliessen(); }

  const p2 = pool({ anzahl: 1, maxAuftraege: 2 });
  try {
    const a = await p2.ausfuehren('threadId');
    const b = await p2.ausfuehren('threadId');
    const c = await p2.ausfuehren('threadId');
    assert.equal(a, b);
    assert.notEqual(b, c);
    assert.equal(p2.zustand().statistik.ersetztAuftraege, 1);
  } finally { await p2.schliessen(); }
});

test('3 Startfehler hintereinander → Alarmzustand, Auftrag scheitert, kein Rückfall auf den Hauptthread', async () => {
  const p = pool({ aufgabenModul: KAPUTT });
  try {
    await assert.rejects(p.ausfuehren('echo', ['x']), PdfWorkerNichtVerfuegbar);
    const z = p.zustand();
    assert.ok(z.alarm, 'Alarm gesetzt');
    assert.ok(z.startFehlerInFolge >= 3);
    assert.equal(z.modus, 'worker');
    assert.ok(p.logger.zeilen.some((l) => l.startsWith('ALARM: PDF-Worker')), 'Alarm im Log');
    // Ein weiterer Auftrag versucht erneut einen Start (ohne Endlosschleife) und scheitert wieder.
    await assert.rejects(p.ausfuehren('echo', ['y']), PdfWorkerNichtVerfuegbar);
  } finally { await p.schliessen(); }
});

test('schliessen() beendet laufende und wartende Aufträge sofort', async () => {
  const p = pool({ anzahl: 1 });
  const laufend = assert.rejects(p.ausfuehren('blockiere', [20_000]), PdfWorkerNichtVerfuegbar);
  const wartend = assert.rejects(p.ausfuehren('echo', [1]), PdfWorkerNichtVerfuegbar);
  await new Promise((r) => setTimeout(r, 300));
  const start = Date.now();
  await p.schliessen();
  await laufend;
  await wartend;
  assert.ok(Date.now() - start < 3000);
  assert.deepEqual(p.zustand().worker, []);
  assert.equal(await p.ausfuehren('echo', ['wieder']), 'wieder', 'nach schliessen wieder nutzbar');
  await p.schliessen();
});

test('Leerlauf-Worker halten den Prozess nicht am Leben (ohne schliessen)', () => {
  const pfad = fileURLToPath(new URL('../../src/services/pdfWorkerPool.js', import.meta.url));
  const skript = `
    import { erstellePdfWorkerPool } from ${JSON.stringify(pfad)};
    const p = erstellePdfWorkerPool({ aufgabenModul: ${JSON.stringify(TEST_AUFGABEN)}, logger: { log() {}, warn() {}, error() {} } });
    console.log(await p.ausfuehren('echo', ['ok']));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', skript], { encoding: 'utf8', timeout: 15_000 });
  assert.equal(r.error, undefined, 'Prozess endet von selbst');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'ok');
});

test('Fassade: modus aus rechnet im Hauptthread mit derselben Aufgabenliste', async () => {
  const inline = erstellePdfArbeit({ modus: 'aus', aufgabenModul: TEST_AUFGABEN });
  const { threadId } = await import('node:worker_threads');
  assert.equal(await inline.ausfuehren('threadId'), threadId);
  await assert.rejects(inline.ausfuehren('wirfEingangFehler'), PdfEingangFehler);
  assert.deepEqual(inline.zustand(), { modus: 'inline' });
  assert.throws(() => erstellePdfArbeit({ modus: 'vielleicht' }), /Unbekannte Betriebsart/);
});
