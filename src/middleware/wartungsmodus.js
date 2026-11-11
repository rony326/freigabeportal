import { istWartungsmodusAktiv, wartungsHinweis } from '../services/wartungsmodus.js';
import { personHasPermission } from './permissions.js';

// Pfade, die auch im Wartungsmodus laufen: Statusseite, Login (sonst kommt der Admin nicht mehr
// rein), Logo der Wartungsseite und die Backup-Abholung (der Zweck des Modus ist ein sauberer
// Stand für genau dieses Backup).
const OFFEN = [/^\/healthz(\/|$)/, /^\/auth(\/|$)/, /^\/branding(\/|$)/, /^\/api\/n8n\/backup(\/|$)/];
// Maschinenrouten: antworten mit 503 + Retry-After, n8n versucht es später erneut.
const MASCHINEN = [/^\/api\/n8n(\/|$)/, /^\/internal\/cron(\/|$)/];
const RETRY_AFTER_SEKUNDEN = '300';

export function wartungsmodusSperre(db, config) {
  return (req, res, next) => {
    if (!istWartungsmodusAktiv(db)) return next();
    if (OFFEN.some((muster) => muster.test(req.path))) return next();
    if (MASCHINEN.some((muster) => muster.test(req.path))) {
      res.set('Retry-After', RETRY_AFTER_SEKUNDEN);
      return res.status(503).json({ error: 'wartungsmodus', meldung: 'Das Portal ist im Wartungsmodus. Bitte später erneut versuchen.' });
    }
    const person = req.currentPerson;
    if (person && person.aktiv && personHasPermission(db, config, person, 'wartungsmodus_schalten')) {
      res.locals.wartungsmodusAktiv = true;
      return next();
    }
    res.set('Retry-After', RETRY_AFTER_SEKUNDEN);
    return res.status(503).render('wartung', { hinweis: wartungsHinweis(db) });
  };
}
