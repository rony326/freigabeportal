// Rücksprungziel nach der Anmeldung (Prüfung 2026-11-15, U1): wer ohne Sitzung eine Seite aufruft, soll nach dem Login
// dort landen. Das Ziel stammt aus der Adresszeile der Anfrage, wird beim Merken UND nach dem Login geprüft und
// ist nur ein eigener, relativer Seitenpfad – nie eine fremde Adresse (Open Redirect).

// Längste gemerkte Adresse (Pfad + Query).
const ZIEL_MAX = 300;

// Ziele, die kein HTML-Seitenziel sind: Anmeldung selbst, Maschinen-/JSON-Routen, Dateiausgaben (PDF, Backup, CSV,
// Belegdatei/-vorschau) und die öffentliche Prüfseite. Gross-/Kleinschreibung egal, weil Express so routet.
const KEIN_SEITENZIEL = [
  /^\/(auth|api|internal|healthz|downloads|branding|audit-pruefen)(\/|\?|$)/i,
  /^\/admin\/backup\/dateien\//i,
  /^\/auswertung\/export\//i,
  /^\/kreditkarte\/belege\/[^/?]+\/(datei|thumbnail)(\/|\?|$)/i,
];

/**
 * Liefert das Ziel unverändert zurück, wenn es ein sicherer eigener Seitenpfad ist, sonst null.
 * Erlaubt: beginnt mit genau einem "/", höchstens 300 Zeichen, keine Steuerzeichen/Leerzeichen/Backslashes/#,
 * löst relativ zu einer fremden Basis nie auf einen anderen Ursprung auf, ist kein Nicht-Seitenziel (siehe oben).
 * @param {unknown} wert Pfad mit optionaler Query, z. B. "/zeitstempel-pruefen?jobId=5"
 * @returns {string|null}
 */
export function sichereRueckkehr(wert) {
  if (typeof wert !== 'string' || wert.length === 0 || wert.length > ZIEL_MAX) return null;
  if (!wert.startsWith('/') || wert.startsWith('//')) return null;
  if (/[\\\s#\u0000-\u001f\u007f]/.test(wert)) return null;
  // Entschlüsselte Form prüfen: "/%0d%0a" oder "/%5c…" dürfen keine Steuerzeichen/Backslashes einschmuggeln.
  let dekodiert;
  try { dekodiert = decodeURIComponent(wert); } catch { return null; }
  if (/[\\\u0000-\u001f\u007f]/.test(dekodiert) || dekodiert.startsWith('//')) return null;
  try {
    if (new URL(wert, 'http://ziel.invalid').origin !== 'http://ziel.invalid') return null;
  } catch { return null; }
  if (KEIN_SEITENZIEL.some((muster) => muster.test(wert))) return null;
  return wert;
}

/**
 * Erwartet die Anfrage eine HTML-Seite (Browser-Navigation)? Nur dann wird umgeleitet bzw. eine Fehlerseite gezeigt;
 * fetch- und Maschinenaufrufe senden in der Regel kein `text/html` im Accept-Kopf.
 * @param {import('express').Request} req
 * @returns {boolean}
 */
export function erwartetHtml(req) {
  return /text\/html/i.test(String(req.headers?.accept || ''));
}

/**
 * Soll diese Anfrage (auch bei Fehlern) JSON bekommen? Immer unter /api und /downloads (fetch, Bild, Maschinen),
 * sonst nur, wenn der Accept-Kopf JSON nennt und kein HTML.
 * @param {import('express').Request} req
 * @returns {boolean}
 */
export function erwartetJson(req) {
  if (erwartetHtml(req)) return false;
  const pfad = String(req.originalUrl || req.url || '');
  return /^\/(api|downloads)\//i.test(pfad) || /application\/json/i.test(String(req.headers?.accept || ''));
}
