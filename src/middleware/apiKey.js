// Zugriffsschutz für die n8n-Schnittstelle (`/api/n8n/*`, `/api/pool`): Header `X-API-Key`.
// Cron-Aufrufe haben ein eigenes Geheimnis (cronAuth.js), die Backup-Abholung ebenfalls (routes/n8n/backup.js).

import { timingSafeEqual } from 'node:crypto';
import { meldeZugriffVerweigert } from '../services/zugriffsAudit.js';

// Zeitkonstanter Vergleich, damit sich der Schlüssel nicht über Antwortzeiten erraten lässt.
function matches(provided, expected) {
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  if (providedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(providedBuf, expectedBuf);
}

// Middleware-Fabrik: 401, wenn der Header fehlt, falsch ist oder in der Konfiguration kein Schlüssel steht.
// Jeder Fehlversuch landet (ohne den Schlüssel selbst) im Zugriffs-Audit.
export function requireApiKey(config) {
  return (req, res, next) => {
    const key = req.get('X-API-Key');
    if (!key || !config.n8nApiKey || !matches(key, config.n8nApiKey)) {
      // Der uebermittelte Schluessel wird nie protokolliert, nur der Grund.
      meldeZugriffVerweigert(req, { grund: 'api_key', status: 401 });
      return res.status(401).json({ error: 'Ungültiger oder fehlender API-Key' });
    }
    next();
  };
}
