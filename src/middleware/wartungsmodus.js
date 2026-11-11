// Wartungsmodus (docs/admin-bereich.md, Seite "Wartungsmodus"): solange aktiv, antworten Maschinenrouten
// mit 503 + `Retry-After`, normale Nutzer sehen die Wartungsseite. Ausnahmen (Admins mit Recht, Backup,
// Healthcheck, Login, Bestätigungen von n8n) stehen als Muster direkt unterhalb. Ein-/Ausschalten: services/wartungsmodus.js.

import { istWartungsmodusAktiv, wartungsHinweis, wartungsmodusLaeuftLange } from '../services/wartungsmodus.js';
import { personHasPermission } from './permissions.js';

// Pfade, die auch im Wartungsmodus laufen: Statusseite, Login (sonst kommt der Admin nicht mehr
// rein), Logo der Wartungsseite und die Backup-Abholung (der Zweck des Modus ist ein sauberer
// Stand für genau dieses Backup).
const OFFEN = [/^\/healthz(\/|$)/i, /^\/auth(\/|$)/i, /^\/branding(\/|$)/i, /^\/api\/n8n\/backup(\/|$)/i];
// Maschinenrouten: antworten mit 503 + Retry-After, n8n versucht es später erneut.
// Gross-/Kleinschreibung egal: Express routet unabhängig davon, eine abweichende Schreibweise darf die
// JSON-Antwort für Maschinen nicht umgehen.
const MASCHINEN = [/^\/api\/n8n(\/|$)/i, /^\/internal\/cron(\/|$)/i];
// Signierte PDF-Links (n8n, ohne Sitzung) und die PDF-Vorschau der Berechtigten: Berechtigte kommen
// durch, alle anderen bekommen wie die Maschinenrouten JSON statt der HTML-Wartungsseite.
const DOWNLOADS = /^\/downloads(\/|$)/i;
// Bestätigungen von n8n (nach Abholung/Archivierung) schreiben nur das Ergebnis eines schon
// gelaufenen Exports. Bekämen sie 503, bliebe der Vorgang "abholbereit" und n8n würde ihn nochmals
// verbuchen (Doppelbuchung in Bexio).
const BESTAETIGUNGEN = /^\/api\/n8n\/(jobs|rapporte)\/\d+\/(abholung-bestaetigen|archivierung-bestaetigen)\/?$/i;
const RETRY_AFTER_SEKUNDEN = '300';

// Middleware-Fabrik; muss NACH `loadCurrentPerson` laufen, weil Berechtigte durchgelassen werden.
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
      res.locals.wartungsmodusLang = wartungsmodusLaeuftLange(db);
      return next();
    }
    // Die Backup-Seite gehört zum Zweck des Modus (Backup ziehen): ihre Berechtigten kommen dorthin.
    if (person && person.aktiv && /^\/admin\/backup(\/|$)/i.test(req.path) && personHasPermission(db, config, person, 'backup_verwalten')) {
      res.locals.wartungsmodusAktiv = true;
      res.locals.wartungsmodusLang = wartungsmodusLaeuftLange(db);
      return next();
    }
    res.set('Retry-After', RETRY_AFTER_SEKUNDEN);
    if (DOWNLOADS.test(req.path)) return res.status(503).json({ error: 'wartungsmodus', meldung: 'Das Portal ist im Wartungsmodus. Bitte später erneut versuchen.' });
    return res.status(503).render('wartung', { hinweis: wartungsHinweis(db) });
  };
}
