import { currentAuditRequestId } from '../services/auditContext.js';
import { erfasseSeitenaufruf, geraeteIdAusCookie } from '../services/nutzung.js';

// Maschinenrouten, Dateistreams und Branding-Dateien sind keine Seitenaufrufe.
const AUSGENOMMEN = ['/api/n8n', '/internal/cron', '/branding', '/downloads/'];
const STATISCH = /\.(?:css|js|mjs|map|png|jpe?g|gif|svg|ico|webp|woff2?|ttf|eot|pdf|txt|json)$/i;

function ausgenommen(pfad) {
  return STATISCH.test(pfad) || AUSGENOMMEN.some((praefix) => pfad === praefix || pfad.startsWith(praefix.endsWith('/') ? praefix : `${praefix}/`));
}

// Erfasst Seitenaufrufe angemeldeter Personen, deren Antwort HTML ist; wirft nie.
export function nutzungErfassen(db) {
  return (req, res, next) => {
    try {
      const person = req.currentPerson;
      const pfad = req.path;
      // aktiv kommt aus der Datenbank als 0/1 (oder boolean): inaktive Personen nie erfassen.
      if (person && person.aktiv && !ausgenommen(pfad)) erfasseBeiEnde(db, req, res, person, pfad);
    } catch { /* Erfassen darf nie stören. */ }
    return next();
  };
}

function erfasseBeiEnde(db, req, res, person, pfad) {
  const start = process.hrtime.bigint();
  req.nutzung = {
    pfad,
    personId: person.churchtools_person_id,
    geraetId: geraeteIdAusCookie(req, res),
    requestId: currentAuditRequestId(),
  };
  res.on('finish', () => {
    try {
      // Weiterleitungen (z.B. nach Formular-POSTs) sind keine Seitenaufrufe.
      if (res.statusCode >= 300 && res.statusCode < 400) return;
      if (!String(res.getHeader('Content-Type') || '').toLowerCase().startsWith('text/html')) return;
      erfasseSeitenaufruf(db, { req, res, dauerMs: Number(process.hrtime.bigint() - start) / 1e6 });
    } catch { /* Erfassen darf nie stören. */ }
  });
}
