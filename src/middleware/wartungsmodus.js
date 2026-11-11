import { istWartungsmodusAktiv, wartungsHinweis } from '../services/wartungsmodus.js';
import { personHasPermission } from './permissions.js';

// Pfade, die auch im Wartungsmodus laufen: Statusseite, Login (sonst kommt der Admin nicht mehr
// rein), Logo der Wartungsseite und die Backup-Abholung (der Zweck des Modus ist ein sauberer
// Stand für genau dieses Backup).
const OFFEN = [/^\/healthz(\/|$)/, /^\/auth(\/|$)/, /^\/branding(\/|$)/, /^\/api\/n8n\/backup(\/|$)/];
// Maschinenrouten: antworten mit 503 + Retry-After, n8n versucht es später erneut.
const MASCHINEN = [/^\/api\/n8n(\/|$)/, /^\/internal\/cron(\/|$)/];
// Bestätigungen von n8n (nach Abholung/Archivierung) schreiben nur das Ergebnis eines schon
// gelaufenen Exports. Bekämen sie 503, bliebe der Vorgang "abholbereit" und n8n würde ihn nochmals
// verbuchen (Doppelbuchung in Bexio).
const BESTAETIGUNGEN = /^\/api\/n8n\/(jobs|rapporte)\/\d+\/(abholung-bestaetigen|archivierung-bestaetigen)\/?$/;
const RETRY_AFTER_SEKUNDEN = '300';

export function wartungsmodusSperre(db, config) {
  return (req, res, next) => {
    if (!istWartungsmodusAktiv(db)) return next();
    if (OFFEN.some((muster) => muster.test(req.path))) return next();
    if (req.method === 'POST' && BESTAETIGUNGEN.test(req.path)) return next();
    if (MASCHINEN.some((muster) => muster.test(req.path))) {
      res.set('Retry-After', RETRY_AFTER_SEKUNDEN);
      return res.status(503).json({ error: 'wartungsmodus', meldung: 'Das Portal ist im Wartungsmodus. Bitte später erneut versuchen.' });
    }
    const person = req.currentPerson;
    // Wer den Modus schalten oder die Gruppenrechte ändern darf (Superadmin hat Letzteres fest), bleibt
    // nie ausgesperrt: sonst liesse sich der Modus nach einem Rechteentzug nur noch per SQL beenden.
    if (person && person.aktiv
      && (personHasPermission(db, config, person, 'wartungsmodus_schalten') || personHasPermission(db, config, person, 'gruppenrechte_verwalten'))) {
      res.locals.wartungsmodusAktiv = true;
      return next();
    }
    res.set('Retry-After', RETRY_AFTER_SEKUNDEN);
    return res.status(503).render('wartung', { hinweis: wartungsHinweis(db) });
  };
}
