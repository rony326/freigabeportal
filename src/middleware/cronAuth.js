// Zugriffsschutz für `/internal/cron/*`: Header `X-Cron-Secret` (nur noch für externe Auslöser;
// die Standard-Jobs laufen im In-Process-Scheduler, siehe services/scheduler.js).

import { timingSafeEqual } from 'node:crypto';
import { meldeZugriffVerweigert } from '../services/zugriffsAudit.js';

// Zeitkonstanter Vergleich (wie in apiKey.js).
function matches(provided, expected) {
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  if (providedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(providedBuf, expectedBuf);
}

// Middleware-Fabrik: 401 bei fehlendem/falschem Geheimnis, Fehlversuche gehen ins Zugriffs-Audit.
export function requireCronSecret(config) {
  return (req, res, next) => {
    const secret = req.get('X-Cron-Secret');
    if (!secret || !config.cronSecret || !matches(secret, config.cronSecret)) {
      meldeZugriffVerweigert(req, { grund: 'cron_secret', status: 401 });
      return res.status(401).json({ error: 'Ungültiges oder fehlendes Cron-Secret' });
    }
    next();
  };
}
