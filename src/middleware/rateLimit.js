import { rateLimit, ipKeyGenerator } from 'express-rate-limit';

export const RATE_LIMIT_MESSAGE = { error: 'Zu viele Anfragen, bitte später erneut versuchen.' };

function jsonRateLimitHandler(req, res) {
  res.status(429).json(RATE_LIMIT_MESSAGE);
}

const COMMON_OPTIONS = {
  standardHeaders: true,
  legacyHeaders: false,
  handler: jsonRateLimitHandler,
};

export function createPublicRateLimiter(overrides = {}) {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 100,
    ...COMMON_OPTIONS,
    ...overrides,
  });
}

export function createSessionRateLimiter(overrides = {}) {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 300,
    keyGenerator: (req) => (req.currentPerson ? String(req.currentPerson.churchtools_person_id) : ipKeyGenerator(req.ip)),
    ...COMMON_OPTIONS,
    ...overrides,
  });
}

export function createMachineRateLimiter(overrides = {}) {
  return rateLimit({
    windowMs: 60 * 1000,
    limit: 60,
    ...COMMON_OPTIONS,
    ...overrides,
  });
}
