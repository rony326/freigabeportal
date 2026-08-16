import { timingSafeEqual } from 'node:crypto';

function matches(provided, expected) {
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  if (providedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(providedBuf, expectedBuf);
}

export function requireCronSecret(config) {
  return (req, res, next) => {
    const secret = req.get('X-Cron-Secret');
    if (!secret || !matches(secret, config.cronSecret)) {
      return res.status(401).json({ error: 'Ungültiges oder fehlendes Cron-Secret' });
    }
    next();
  };
}
