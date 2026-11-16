// Fassade für PDF-Arbeit mit mupdf (B2): Aufrufer schreiben `await pdfArbeit().ausfuehren(aufgabe, [buffer], { spur })`
// und wissen nicht, ob ein Worker oder der Hauptthread rechnet. Aufgabenliste: workers/pdfAufgaben.js.
//
// Betriebsart (Umgebung PDF_WORKER, geprüft in config/env.js, gesetzt in src/index.js):
// - 'an' (Standard): Pool von Worker-Threads (services/pdfWorkerPool.js); der Hauptthread lädt mupdf
//   dafür nicht.
// - 'aus': dieselben Aufgaben im Hauptthread, per dynamischem import() erst beim ersten Auftrag. Das ist
//   ein bewusster Betriebs-/Testschalter, nie ein automatischer Rückfall – fällt der Pool aus, scheitern
//   die Aufträge mit PdfWorkerNichtVerfuegbar und die Statusseite zeigt den Alarm.
//
// Fehler: PdfEingangFehler (mit `code`), BelegBildFehler und andere Fehler der Aufgaben kommen wie beim direkten
// Aufruf an; dazu die Pool-Fehler (PdfWorkerFehler und Unterklassen), bei denen ein erneuter Versuch sinnvoll ist.
// Menschen bekommen dann PDF_VORUEBERGEHEND_MELDUNG mit Status 503 und Retry-After (antworteSpaeterErneut).

import {
  erstellePdfWorkerPool, PdfWorkerFehler, PdfWorkerUeberlastet, PdfWorkerZeitueberschreitung, PdfWorkerAbsturz, PdfWorkerNichtVerfuegbar,
} from './pdfWorkerPool.js';

export { PdfWorkerFehler, PdfWorkerUeberlastet, PdfWorkerZeitueberschreitung, PdfWorkerAbsturz, PdfWorkerNichtVerfuegbar };

const STANDARD_AUFGABEN = new URL('../workers/pdfAufgaben.js', import.meta.url).href;

// Sekunden für Retry-After, wenn die PDF-Verarbeitung vorübergehend nicht verfügbar ist (503).
export const PDF_WIEDERHOLEN_NACH_SEKUNDEN = 60;

// Meldung für Personen in den Formularen (Spesen, Kreditkarten-Belege, KK-Abgleich), wenn ein PdfWorkerFehler auftritt.
// Gespeichert wurde in diesem Fall nichts; Dateien muss man im Browser erneut auswählen.
export const PDF_VORUEBERGEHEND_MELDUNG = 'Die PDF-Verarbeitung ist gerade ausgelastet. Es wurde nichts gespeichert. Bitte versuche es in einer Minute erneut und wähle dabei die Datei(en) noch einmal aus.';

/**
 * Setzt Status 503 und Retry-After für eine Antwort nach einem PdfWorkerFehler und protokolliert kurz den Grund
 * (ohne Stack: kein Programmfehler). Der Aufrufer rendert danach sein Formular mit PDF_VORUEBERGEHEND_MELDUNG.
 * @param {import('express').Response} res
 * @param {Error} err
 * @param {string} wo kurze Angabe für das Log, z. B. 'Spesen-Einreichung'
 * @returns {import('express').Response}
 */
export function antworteSpaeterErneut(res, err, wo) {
  console.warn(`${wo}: PDF-Verarbeitung vorübergehend nicht verfügbar (${err.name}: ${err.message})`);
  res.set('Retry-After', String(PDF_WIEDERHOLEN_NACH_SEKUNDEN));
  return res.status(503);
}

/**
 * Erzeugt eine eigene Fassade (Server: einmal über konfigurierePdfArbeit; Tests: mit eigenen Optionen).
 * @param {{modus?: 'an'|'aus', aufgabenModul?: string}} [optionen] übrige Optionen gehen an erstellePdfWorkerPool
 * @returns {{modus: string, ausfuehren: Function, zustand: Function, schliessen: Function}}
 */
export function erstellePdfArbeit({ modus = 'an', ...poolOptionen } = {}) {
  if (modus === 'aus') {
    const modulUrl = poolOptionen.aufgabenModul ?? STANDARD_AUFGABEN;
    return {
      modus: 'aus',
      async ausfuehren(aufgabe, args = []) {
        const { AUFGABEN } = await import(modulUrl);
        const fn = Object.hasOwn(AUFGABEN, aufgabe) ? AUFGABEN[aufgabe] : null;
        if (typeof fn !== 'function') throw new Error(`Unbekannte PDF-Aufgabe: ${aufgabe}`);
        return fn(...args);
      },
      zustand: () => ({ modus: 'inline' }),
      async schliessen() {},
    };
  }
  if (modus !== 'an') throw new Error(`Unbekannte Betriebsart der PDF-Verarbeitung: ${modus}`);
  const pool = erstellePdfWorkerPool(poolOptionen);
  return { modus: 'an', ausfuehren: pool.ausfuehren, zustand: pool.zustand, schliessen: pool.schliessen };
}

let standardOptionen = {};
let standard = null;

/**
 * Übernimmt die Einstellungen aus config.pdfWorker (src/index.js beim Start). Eine bereits laufende
 * Standard-Fassade wird beendet und beim nächsten Auftrag neu aufgebaut.
 * @param {{modus?: 'an'|'aus', anzahl?: number, speicherGrenzeMb?: number, zeitlimitFaktor?: number}} [einstellungen]
 */
export function konfigurierePdfArbeit(einstellungen = {}) {
  standardOptionen = { ...einstellungen };
  const alt = standard;
  standard = null;
  alt?.schliessen().catch(() => {});
}

/** Die gemeinsame Fassade des Prozesses (wird beim ersten Aufruf erzeugt; Worker starten erst beim ersten Auftrag). */
export function pdfArbeit() {
  standard ??= erstellePdfArbeit(standardOptionen);
  return standard;
}

/** Zustand für die Statusseite; startet nichts. */
export function pdfArbeitZustand() {
  if (standard) return standard.zustand();
  return standardOptionen.modus === 'aus' ? { modus: 'inline' } : { modus: 'worker', worker: [], alarm: null, startFehlerInFolge: 0 };
}

/** Beendet alle PDF-Worker (Shutdown in src/index.js, Tests). */
export async function schliessePdfWorker() {
  await standard?.schliessen();
}
