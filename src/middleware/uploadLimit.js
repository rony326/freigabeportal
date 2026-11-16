// Schutz der multipart-Upload-Routen (multer.memoryStorage puffert alles im Arbeitsspeicher): Gesamtgrösse je Anfrage begrenzen
// und die Zuständigkeit vor dem Upload prüfen. multer kennt nur Limits je Datei und je Anzahl Dateien, kein Gesamtlimit.

// Höchste Gesamtgrösse einer Upload-Anfrage (alle Dateien und Felder zusammen).
export const MAX_UPLOAD_GESAMT_BYTES = 60 * 1024 * 1024;

const MB = 1024 * 1024;

// Bricht die Anfrage ab: antwortet sofort, hört auf zu lesen (req.pause, der Absender läuft über den TCP-Gegendruck auf) und kappt die
// Verbindung kurz nach der Antwort, statt den Rest des Bodies noch entgegenzunehmen. Die kurze Frist ist nötig, weil ein sofortiges
// Schliessen bei ungelesenen Daten ein RST auslöst, das beim Absender die schon angekommene Antwort verwerfen kann (aus demselben
// Grund wird bewusst kein `Connection: close` gesetzt: Node schlösse den Socket dann sofort nach der Antwort). Ist der Body
// schon vollständig gelesen (req.complete), bleibt die Verbindung bestehen.
const KAPPEN_NACH_MS = 1500;
function antworteUndBrichAb(req, res) {
  if (req.complete) return;
  req.pause();
  res.once('finish', () => {
    setTimeout(() => req.destroy(), KAPPEN_NACH_MS).unref();
  });
}

/**
 * Begrenzt die Gesamtgrösse einer multipart-Anfrage und reicht sie sonst an `middleware` (multer) weiter.
 * Zwei Stufen: ein deklariertes Content-Length über dem Limit wird abgewiesen, bevor ein Byte gelesen wird; fehlt die Angabe
 * (chunked) oder lügt sie, zählt der Zähler die tatsächlich gelesenen Bytes und bricht beim Überschreiten ab. Antwort: 413 mit
 * HTML-Fehlerseite. Aufruf wie `mitAuditKontext(begrenzeUploadGroesse(upload.any()))`.
 * @param {Function} middleware multer-Middleware
 * @param {number} [maxBytes]
 */
export function begrenzeUploadGroesse(middleware, maxBytes = MAX_UPLOAD_GESAMT_BYTES) {
  const lehneAb = (req, res) => {
    antworteUndBrichAb(req, res);
    res.status(413).render('error', {
      message: `Die hochgeladenen Dateien sind zusammen zu gross. Pro Absenden sind höchstens ${Math.round(maxBytes / MB)} MB erlaubt. Bitte lade weniger oder kleinere Dateien hoch.`,
    });
  };
  return (req, res, callback) => {
    const deklariert = Number(req.headers['content-length']);
    if (Number.isFinite(deklariert) && deklariert > maxBytes) return lehneAb(req, res);
    // Nur multipart wird gezählt: andere Bodies hat ein vorgeschalteter Parser schon gelesen.
    if (!req.is('multipart/form-data')) return middleware(req, res, callback);
    let gelesen = 0;
    let abgebrochen = false;
    const zaehle = (chunk) => {
      gelesen += chunk.length;
      if (abgebrochen || gelesen <= maxBytes) return;
      abgebrochen = true;
      req.removeListener('data', zaehle);
      req.unpipe();
      lehneAb(req, res);
    };
    req.on('data', zaehle);
    middleware(req, res, (...args) => {
      req.removeListener('data', zaehle);
      if (abgebrochen) return; // Die Anfrage ist schon beantwortet; ein Folgefehler von multer (Abbruch) zählt nicht.
      callback(...args);
    });
  };
}

/**
 * Express-Middleware: führt die Zuständigkeitsprüfung `pruefe(req, res)` aus, bevor multer den Body annimmt.
 * `pruefe` liefert ein Wahrheitswert-Ergebnis und rendert bei Ablehnung selbst die Antwort (z. B. ladeKontierbarenJob). Bei
 * Ablehnung wird die Verbindung nach der Antwort gekappt, der Upload also nicht entgegengenommen. Nur für Prüfungen, die allein
 * von Adresse und Sitzung abhängen (nicht von Formularfeldern); der Handler prüft nach dem Upload weiterhin selbst.
 */
export function zustaendigkeitVorUpload(pruefe) {
  return (req, res, next) => {
    // Nur ein multipart-Body ist das Risiko; ein gewöhnlicher Formular-Post (schon geparst) läuft den normalen Weg weiter, inklusive CSRF-Prüfung vor der Zuständigkeit.
    if (!req.is('multipart/form-data')) return next();
    let zustaendig;
    try {
      zustaendig = pruefe(req, res);
    } catch (err) {
      return next(err);
    }
    if (zustaendig) return next();
    antworteUndBrichAb(req, res);
  };
}
