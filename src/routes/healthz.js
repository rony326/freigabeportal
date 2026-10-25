import { Router } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createPublicRateLimiter } from '../middleware/rateLimit.js';
import { getConfigValue } from '../db/adminConfigRepo.js';
import { createStatusCache, pruefeDatenbank } from '../services/statusPruefungen.js';
import { createTsaErreichbarkeit } from '../services/statusTsa.js';

const sha = (s) => createHash('sha256').update(String(s)).digest();
const paketVersion = () => {
  try { return JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version; } catch { return 'unbekannt'; }
};

export function createHealthzRouter({
  db, config, versionFn = paketVersion, tsaVersuch, tsaErreichbarkeit = createTsaErreichbarkeit(),
  statusCache = createStatusCache({ db, config, tsaErreichbarkeit, tsaVersuch }),
} = {}) {
  const router = Router();
  router.get('/', createPublicRateLimiter({ windowMs: 60_000, limit: 120 }), (req, res) => {
    let secret = '';
    try { secret = getConfigValue(db, 'monitoring_secret') || ''; } catch { /* DB-Fehler unten */ }
    const header = req.get('x-monitoring-key') || '';
    // Gespeichert ist nur SHA-256 (hex) des Schlüssels; beide Seiten 32 Bytes für timingSafeEqual.
    const gueltig = /^[0-9a-f]{64}$/.test(secret) && timingSafeEqual(sha(header), Buffer.from(secret, 'hex'));
    if (!gueltig) {
      if (pruefeDatenbank(db).status === 'fehler') return res.status(503).json({ status: 'fehler' });
      return res.json({ status: 'ok' });
    }
    // Zwischengespeichert (30 s), gemeinsam mit Statusseite und Dashboard.
    const ergebnis = statusCache.ergebnis();
    const body = { status: ergebnis.status, geprueft_am: ergebnis.geprueft_am, version: versionFn(), dienste: ergebnis.dienste };
    res.status(ergebnis.dienste.datenbank?.status === 'fehler' ? 503 : 200).json(body);
  });
  return router;
}
