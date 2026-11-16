// Pool fester Grösse für PDF-Worker (B2): PDF-Arbeit mit mupdf blockiert sonst die Event-Loop für
// ihre ganze Laufzeit (QR-Erkennung bis ~19 s). Aufrufer nutzen nicht den Pool direkt, sondern die
// Fassade services/pdfArbeit.js. Architektur und Betrieb: docs/architektur.md, Abschnitt "PDF-Worker".
//
// Regeln:
// - Höchstens `anzahl` Worker (Standard 2), gestartet erst bei Bedarf; ein Worker bearbeitet einen Auftrag.
// - Zwei Spuren: 'interaktiv' geht vor 'hintergrund'; Hintergrundaufträge belegen höchstens einen Worker gleichzeitig.
// - Warteschlange höchstens `maxWarteschlange` (100) → PdfWorkerUeberlastet.
// - Zeitlimit je Auftrag → Worker wird beendet (terminate bricht auch laufende WASM-Arbeit ab) und
//   bei Bedarf neu gestartet, der Auftrag scheitert mit PdfWorkerZeitueberschreitung.
// - Nach einem Auftrag wird der Worker ersetzt, wenn sein external-Speicher (mupdf-WASM, wächst nur)
//   über `speicherGrenzeMb` liegt oder er `maxAuftraege` Aufträge erledigt hat. resourceLimits
//   begrenzt nur den JS-Heap, nicht den WASM-Speicher – daher diese Prüfung.
// - Absturz ('error'/'exit') → laufender Auftrag scheitert mit PdfWorkerAbsturz, Ersatz bei Bedarf.
//   Scheitert der Start 3× hintereinander → Alarm im Log und im Zustand (Statusseite), wartende
//   Aufträge scheitern mit PdfWorkerNichtVerfuegbar. Es gibt bewusst KEINEN automatischen Rückfall
//   auf Verarbeitung im Hauptthread (Betreiberentscheid); jeder neue Auftrag versucht einen Start.
// - Leerlauf-Worker sind unref() (halten den Prozess nicht am Leben, wichtig für node --test) und
//   werden nach `leerlaufMs` (5 min) beendet; während eines Auftrags ref().
// - Bytes werden nur als eigene Kopie übertragen (workers/pdfUebergabe.js), nie der Buffer des Aufrufers.

import { Worker } from 'node:worker_threads';
import { PdfEingangFehler } from './pdfFehler.js';
import { kopiereFuerTransfer, alsBuffer } from '../workers/pdfUebergabe.js';

// Gemeinsame Basis der Pool-Fehler (Aufrufer unterscheiden damit "Worker-Problem" von "Prüfergebnis").
export class PdfWorkerFehler extends Error {
  constructor(message) {
    super(message);
    this.name = this.constructor.name;
  }
}
export class PdfWorkerUeberlastet extends PdfWorkerFehler {}
export class PdfWorkerZeitueberschreitung extends PdfWorkerFehler {}
export class PdfWorkerAbsturz extends PdfWorkerFehler {}
export class PdfWorkerNichtVerfuegbar extends PdfWorkerFehler {}

// Zeitlimit je Aufgabe in ms (multipliziert mit `zeitlimitFaktor`, Umgebung PDF_WORKER_ZEITLIMIT_FAKTOR).
export const STANDARD_ZEITLIMITS_MS = {
  eingangPruefen: 10_000,
  vorschaubild: 10_000,
  textExtrahieren: 10_000,
  qrErkennen: 15_000,
  eingangAnalysieren: 20_000,
};
const ZEITLIMIT_UNBEKANNT_MS = 10_000;
const START_ZEITLIMIT_MS = 30_000;
const MAX_STARTFEHLER = 3;
const SPUREN = new Set(['interaktiv', 'hintergrund']);
const MB = 1024 * 1024;

// Baut einen Fehler aus {klasse, code, message} wieder auf (PdfEingangFehler behält `code` für den 422-Eingang).
function baueFehler({ klasse, code, message }) {
  if (klasse === 'PdfEingangFehler') return new PdfEingangFehler(code, message);
  const err = new Error(message);
  if (klasse && klasse !== 'Error') err.name = klasse;
  if (code) err.code = code;
  return err;
}

/**
 * @param {object} [optionen]
 * @param {number} [optionen.anzahl=2] Worker (1–4)
 * @param {string} [optionen.aufgabenModul] URL (href) eines Moduls mit `export const AUFGABEN` – nur für Tests; Standard workers/pdfAufgaben.js
 * @param {object} [optionen.zeitlimits] Zeitlimit je Aufgabenname in ms (überschreibt den Standard)
 * @param {number} [optionen.zeitlimitFaktor=1]
 * @param {number} [optionen.speicherGrenzeMb=250] external-Speicher, ab dem ein Worker nach dem Auftrag ersetzt wird
 * @param {number} [optionen.maxAuftraege=200] Aufträge, nach denen ein Worker ersetzt wird
 * @param {number} [optionen.maxWarteschlange=100]
 * @param {number} [optionen.leerlaufMs=300000]
 * @param {number} [optionen.maxOldGenerationSizeMb=512] JS-Heap-Grenze je Worker
 * @param {{log: Function, warn: Function, error: Function}} [optionen.logger=console]
 */
export function erstellePdfWorkerPool({
  anzahl = 2,
  aufgabenModul,
  zeitlimits = {},
  zeitlimitFaktor = 1,
  speicherGrenzeMb = 250,
  maxAuftraege = 200,
  maxWarteschlange = 100,
  leerlaufMs = 5 * 60 * 1000,
  startZeitlimitMs = START_ZEITLIMIT_MS,
  maxOldGenerationSizeMb = 512,
  logger = console,
  workerPfad = new URL('../workers/pdfWorker.js', import.meta.url),
} = {}) {
  const slots = new Set();
  const warte = { interaktiv: [], hintergrund: [] };
  const beendigungen = new Set();
  let naechsteId = 0;
  let naechsteNr = 0;
  let startFehlerInFolge = 0;
  let startSperre = false;
  let alarm = null;
  const statistik = { erledigt: 0, fehlgeschlagen: 0, zeitueberschreitungen: 0, abstuerze: 0, ueberlastet: 0, ersetztSpeicher: 0, ersetztAuftraege: 0, neustarts: 0, letzterNeustart: null };

  const zeitlimitFuer = (aufgabe) =>
    Math.max(1, Math.round((zeitlimits[aufgabe] ?? STANDARD_ZEITLIMITS_MS[aufgabe] ?? ZEITLIMIT_UNBEKANNT_MS) * zeitlimitFaktor));
  const wartend = () => warte.interaktiv.length + warte.hintergrund.length;
  const hintergrundLaeuft = () => [...slots].some((s) => s.auftrag?.spur === 'hintergrund');

  // Beendet einen Worker geplant (exit/error danach werden ignoriert).
  function beende(slot) {
    if (slot.zustand === 'beendet') return;
    slot.zustand = 'beendet';
    slots.delete(slot);
    clearTimeout(slot.leerlaufTimer);
    clearTimeout(slot.auftragTimer);
    clearTimeout(slot.startTimer);
    const p = slot.worker.terminate().catch(() => {}).finally(() => beendigungen.delete(p));
    beendigungen.add(p);
  }

  function lehneWartendeAb(fehler) {
    for (const spur of Object.keys(warte)) {
      for (const a of warte[spur].splice(0)) a.reject(fehler);
    }
  }

  function startFehlgeschlagen(err) {
    startFehlerInFolge += 1;
    logger.error(`PDF-Worker konnte nicht gestartet werden (${startFehlerInFolge}. Fehlschlag in Folge): ${err?.message ?? err}`);
    if (startFehlerInFolge >= MAX_STARTFEHLER) {
      startSperre = true;
      if (!alarm) {
        alarm = { seit: new Date().toISOString(), grund: String(err?.message ?? err) };
        logger.error(`ALARM: PDF-Worker ${startFehlerInFolge}× hintereinander nicht startbar – PDF-Verarbeitung (Vorschaubild, QR-Erkennung, Eingangsprüfung) steht still. Kein Rückfall auf den Hauptthread; bitte Installation (mupdf) und Speicher prüfen.`);
      }
      lehneWartendeAb(new PdfWorkerNichtVerfuegbar('Die PDF-Verarbeitung ist zurzeit nicht verfügbar.'));
    }
  }

  // Worker ist frei: unref (hält den Prozess nicht am Leben), nach leerlaufMs beenden.
  function leerlauf(slot) {
    slot.zustand = 'frei';
    slot.worker.unref();
    clearTimeout(slot.leerlaufTimer);
    slot.leerlaufTimer = setTimeout(() => { if (slot.zustand === 'frei') beende(slot); }, leerlaufMs);
    slot.leerlaufTimer.unref();
  }

  function onNachricht(slot, m) {
    if (slot.zustand === 'beendet') return;
    if (m?.typ === 'bereit' && slot.zustand === 'startet') {
      clearTimeout(slot.startTimer);
      if (alarm) logger.log(`PDF-Worker startet wieder (Alarm seit ${alarm.seit} aufgehoben).`);
      startFehlerInFolge = 0;
      startSperre = false;
      alarm = null;
      leerlauf(slot);
      pump();
      return;
    }
    if (m?.typ !== 'ergebnis' || !slot.auftrag || slot.auftrag.id !== m.id) return;
    const a = slot.auftrag;
    clearTimeout(slot.auftragTimer);
    slot.auftrag = null;
    slot.auftraege += 1;
    slot.external = Number(m.external) || 0;
    const externalMb = Math.round(slot.external / MB);
    logger.log(`PDF-Worker ${slot.nr}: ${a.aufgabe} (${a.spur}) ${m.ok ? 'fertig' : 'mit Fehler'} in ${m.dauerMs} ms, Wartezeit ${a.gestartet - a.eingereiht} ms, Speicher ${externalMb} MB`);
    if (m.ok) { statistik.erledigt += 1; a.resolve(alsBuffer(m.ergebnis)); }
    else { statistik.fehlgeschlagen += 1; a.reject(baueFehler(m.fehler ?? {})); }

    if (slot.external > speicherGrenzeMb * MB) {
      statistik.ersetztSpeicher += 1;
      logger.log(`PDF-Worker ${slot.nr} wird ersetzt: Speicher ${externalMb} MB über der Grenze von ${speicherGrenzeMb} MB.`);
      beende(slot);
    } else if (slot.auftraege >= maxAuftraege) {
      statistik.ersetztAuftraege += 1;
      logger.log(`PDF-Worker ${slot.nr} wird nach ${slot.auftraege} Aufträgen ersetzt.`);
      beende(slot);
    } else {
      leerlauf(slot);
    }
    pump();
  }

  function onEnde(slot, err, code) {
    if (slot.zustand === 'beendet') return;
    const warStart = slot.zustand === 'startet';
    slot.zustand = 'beendet';
    slots.delete(slot);
    clearTimeout(slot.leerlaufTimer);
    clearTimeout(slot.auftragTimer);
    clearTimeout(slot.startTimer);
    const grund = err ? err.message : `Exit-Code ${code}`;
    if (slot.auftrag) {
      statistik.abstuerze += 1;
      logger.error(`PDF-Worker ${slot.nr} abgestürzt während ${slot.auftrag.aufgabe}: ${grund}`);
      slot.auftrag.reject(new PdfWorkerAbsturz(`Die PDF-Verarbeitung ist abgestürzt (${grund}).`));
      slot.auftrag = null;
    } else if (!warStart) {
      logger.warn(`PDF-Worker ${slot.nr} unerwartet beendet: ${grund}`);
    }
    if (warStart) startFehlgeschlagen(err ?? new Error(grund));
    pump();
  }

  function starte() {
    const slot = { nr: ++naechsteNr, zustand: 'startet', auftrag: null, auftraege: 0, external: 0 };
    try {
      slot.worker = new Worker(workerPfad, {
        workerData: { aufgabenModul },
        // --input-type (node -e) ist im Worker unzulässig und liesse jeden Start scheitern.
        execArgv: process.execArgv.filter((a) => !a.startsWith('--input-type')),
        resourceLimits: { maxOldGenerationSizeMb },
      });
    } catch (err) {
      startFehlgeschlagen(err);
      queueMicrotask(pump);
      return;
    }
    if (naechsteNr > 1) { statistik.neustarts += 1; statistik.letzterNeustart = new Date().toISOString(); }
    slots.add(slot);
    slot.worker.on('message', (m) => onNachricht(slot, m));
    slot.worker.on('error', (err) => onEnde(slot, err));
    slot.worker.on('exit', (code) => onEnde(slot, null, code));
    slot.startTimer = setTimeout(() => {
      if (slot.zustand !== 'startet') return;
      beende(slot);
      startFehlgeschlagen(new Error(`Start dauerte länger als ${startZeitlimitMs} ms`));
      pump();
    }, startZeitlimitMs);
    slot.startTimer.unref();
  }

  function sende(slot, a) {
    clearTimeout(slot.leerlaufTimer);
    slot.zustand = 'belegt';
    slot.auftrag = a;
    a.gestartet = Date.now();
    slot.worker.ref();
    const { wert, transfer } = kopiereFuerTransfer(a.args);
    a.args = null;
    try {
      slot.worker.postMessage({ id: a.id, aufgabe: a.aufgabe, args: wert }, transfer);
    } catch (err) {
      slot.auftrag = null;
      leerlauf(slot);
      a.reject(err);
      return;
    }
    const limit = zeitlimitFuer(a.aufgabe);
    slot.auftragTimer = setTimeout(() => {
      if (slot.auftrag !== a) return;
      statistik.zeitueberschreitungen += 1;
      logger.error(`PDF-Worker ${slot.nr}: ${a.aufgabe} nach ${limit} ms abgebrochen (Zeitlimit), Worker wird ersetzt.`);
      slot.auftrag = null;
      beende(slot);
      a.reject(new PdfWorkerZeitueberschreitung(`Die PDF-Verarbeitung (${a.aufgabe}) hat das Zeitlimit von ${limit} ms überschritten.`));
      pump();
    }, limit);
  }

  // Verteilt Wartende auf freie Worker und startet bei Bedarf weitere (bis `anzahl`).
  function pump() {
    for (;;) {
      const spur = warte.interaktiv.length ? 'interaktiv' : (warte.hintergrund.length && !hintergrundLaeuft() ? 'hintergrund' : null);
      if (!spur) break;
      const slot = [...slots].find((s) => s.zustand === 'frei');
      if (!slot) break;
      sende(slot, warte[spur].shift());
    }
    if (startSperre) return;
    const bedarf = warte.interaktiv.length + (warte.hintergrund.length && !hintergrundLaeuft() ? 1 : 0);
    let startend = [...slots].filter((s) => s.zustand === 'startet' || s.zustand === 'frei').length;
    while (slots.size < anzahl && startend < bedarf && !startSperre) {
      starte();
      startend += 1;
    }
  }

  return {
    /**
     * Führt eine Aufgabe in einem Worker aus.
     * @param {string} aufgabe Name aus workers/pdfAufgaben.js
     * @param {any[]} [args] Buffer/Uint8Array werden kopiert übertragen; der Buffer des Aufrufers bleibt unverändert
     * @param {{spur?: 'interaktiv'|'hintergrund'}} [optionen]
     * @returns {Promise<any>} Ergebnis (Uint8Array wieder als Buffer)
     */
    ausfuehren(aufgabe, args = [], { spur = 'interaktiv' } = {}) {
      if (!SPUREN.has(spur)) return Promise.reject(new TypeError(`Unbekannte Spur: ${spur}`));
      if (wartend() >= maxWarteschlange) {
        statistik.ueberlastet += 1;
        logger.warn(`PDF-Worker überlastet: ${wartend()} Aufträge warten, ${aufgabe} abgewiesen.`);
        return Promise.reject(new PdfWorkerUeberlastet('Die PDF-Verarbeitung ist ausgelastet; bitte später erneut versuchen.'));
      }
      // Nach einem Alarm darf jeder neue Auftrag genau einen weiteren Startversuch auslösen (kein Dauerversuch im Leerlauf).
      startSperre = false;
      return new Promise((resolve, reject) => {
        warte[spur].push({ id: ++naechsteId, aufgabe, args, spur, resolve, reject, eingereiht: Date.now() });
        pump();
      });
    },

    /** Momentaufnahme für Statusseite und Tests (startet nie einen Worker). */
    zustand() {
      const liste = [...slots];
      return {
        modus: 'worker',
        anzahl,
        speicherGrenzeMb,
        worker: liste.map((s) => ({ nr: s.nr, zustand: s.zustand, auftraege: s.auftraege, speicherMb: Math.round(s.external / MB) })),
        warteschlange: { interaktiv: warte.interaktiv.length, hintergrund: warte.hintergrund.length },
        startFehlerInFolge,
        alarm,
        statistik: { ...statistik },
      };
    },

    /** Beendet alle Worker; laufende und wartende Aufträge scheitern mit PdfWorkerNichtVerfuegbar. Danach wieder nutzbar. */
    async schliessen() {
      const fehler = new PdfWorkerNichtVerfuegbar('Die PDF-Verarbeitung wird beendet.');
      lehneWartendeAb(fehler);
      for (const slot of [...slots]) {
        const a = slot.auftrag;
        slot.auftrag = null;
        beende(slot);
        a?.reject(fehler);
      }
      await Promise.all([...beendigungen]);
    },
  };
}
