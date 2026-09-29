import { timingSafeEqual } from 'node:crypto';
import { meldeZugriffVerweigert } from '../services/zugriffsAudit.js';

function matches(provided, expected) {
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  if (providedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(providedBuf, expectedBuf);
}

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
