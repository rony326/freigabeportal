export function requireCronSecret(config) {
  return (req, res, next) => {
    const secret = req.get('X-Cron-Secret');
    if (!secret || secret !== config.cronSecret) {
      return res.status(401).json({ error: 'Ungültiges oder fehlendes Cron-Secret' });
    }
    next();
  };
}
