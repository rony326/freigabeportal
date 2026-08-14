export function requireApiKey(config) {
  return (req, res, next) => {
    const key = req.get('X-API-Key');
    if (!key || key !== config.n8nApiKey) {
      return res.status(401).json({ error: 'Ungültiger oder fehlender API-Key' });
    }
    next();
  };
}
