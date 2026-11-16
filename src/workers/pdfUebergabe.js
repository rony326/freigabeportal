// Übergabe von Bytes zwischen Hauptthread und PDF-Worker (ohne mupdf, beide Seiten laden es).
//
// Regel: übertragen (transferList) wird immer nur eine eigens angelegte Kopie. Den Buffer des
// Aufrufers selbst zu übertragen, wäre falsch: er wäre danach leer (n8n/jobs.js braucht ihn noch für
// Hash und Datei), und kleine Buffer liegen im gemeinsamen Speicherpool von Node – ihr ArrayBuffer
// (z. B. req.file.buffer.buffer) gehört vielen anderen Buffern mit.

// Nur einfache Objekte und Arrays werden durchlaufen (Ergebnisse der Aufgaben, Argumentlisten).
function istEinfach(wert) {
  if (Array.isArray(wert)) return true;
  if (wert === null || typeof wert !== 'object') return false;
  const proto = Object.getPrototypeOf(wert);
  return proto === Object.prototype || proto === null;
}

/**
 * Ersetzt jedes Uint8Array (auch Buffer) in `wert` durch eine eigene Kopie und sammelt deren
 * ArrayBuffer für die transferList.
 * @returns {{wert: any, transfer: ArrayBuffer[]}}
 */
export function kopiereFuerTransfer(wert) {
  const transfer = [];
  const gehe = (w, tiefe) => {
    if (w instanceof Uint8Array) {
      const kopie = new Uint8Array(w.byteLength);
      kopie.set(w);
      transfer.push(kopie.buffer);
      return kopie;
    }
    if (tiefe > 4 || !istEinfach(w)) return w;
    if (Array.isArray(w)) return w.map((x) => gehe(x, tiefe + 1));
    return Object.fromEntries(Object.entries(w).map(([k, x]) => [k, gehe(x, tiefe + 1)]));
  };
  return { wert: gehe(wert, 0), transfer };
}

/** Macht aus jedem empfangenen Uint8Array wieder einen Buffer (ohne Kopie, gleicher Speicher). */
export function alsBuffer(wert, tiefe = 0) {
  if (wert instanceof Uint8Array) return Buffer.from(wert.buffer, wert.byteOffset, wert.byteLength);
  if (tiefe > 4 || !istEinfach(wert)) return wert;
  if (Array.isArray(wert)) return wert.map((x) => alsBuffer(x, tiefe + 1));
  return Object.fromEntries(Object.entries(wert).map(([k, x]) => [k, alsBuffer(x, tiefe + 1)]));
}

/** Fehler als übertragbares Objekt {klasse, code, message} (ohne Stack). */
export function fehlerAlsDaten(err) {
  return {
    klasse: typeof err?.name === 'string' ? err.name : 'Error',
    code: typeof err?.code === 'string' ? err.code : null,
    message: String(err?.message ?? err),
  };
}
