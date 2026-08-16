import { timingSafeEqual } from 'node:crypto';

function matches(provided, expected) {
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  if (providedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(providedBuf, expectedBuf);
}

export function requireApiKey(config) {
  return (req, res, next) => {
    const key = req.get('X-API-Key');
    if (!key || !matches(key, config.n8nApiKey)) {
      return res.status(401).json({ error: 'Ungültiger oder fehlender API-Key' });
    }
    next();
  };
}
