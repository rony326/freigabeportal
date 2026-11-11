// Drei Begrenzer (express-rate-limit), eingehängt in app.js: öffentlich (je IP), angemeldet (je Person),
// Maschinen (n8n/Cron/Backup). Bei Überschreitung antworten sie mit 429 und JSON.

import { rateLimit, ipKeyGenerator } from 'express-rate-limit';

export const RATE_LIMIT_MESSAGE = { error: 'Zu viele Anfragen, bitte später erneut versuchen.' };

function jsonRateLimitHandler(req, res) {
  res.status(429).json(RATE_LIMIT_MESSAGE);
}

const COMMON_OPTIONS = {
  // standardHeaders: true (Draft-6-Format mit getrennten Headern) wurde bewusst dem einzelnen kombinierten RateLimit-Header von Draft 7 vorgezogen, damit Tests auf getrennte RateLimit-Limit-Header prüfen können.
  standardHeaders: true,
  legacyHeaders: false,
  handler: jsonRateLimitHandler,
};

// Öffentliche Seiten/Login: 100 Anfragen je 15 Min. und IP.
export function createPublicRateLimiter(overrides = {}) {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 100,
    ...COMMON_OPTIONS,
    ...overrides,
  });
}

// Angemeldete Seiten: 300 Anfragen je 15 Min., gezählt je Person (ohne Anmeldung je IP).
export function createSessionRateLimiter(overrides = {}) {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 300,
    keyGenerator: (req) => (req.currentPerson ? String(req.currentPerson.churchtools_person_id) : ipKeyGenerator(req.ip)),
    ...COMMON_OPTIONS,
    ...overrides,
  });
}

// n8n-/Cron-/Backup-Routen: 60 Anfragen je Minute.
export function createMachineRateLimiter(overrides = {}) {
  return rateLimit({
    windowMs: 60 * 1000,
    limit: 60,
    ...COMMON_OPTIONS,
    ...overrides,
  });
}
