// Drei Begrenzer (express-rate-limit), eingehängt in app.js: öffentlich (je IP), angemeldet (je Person),
// Maschinen (n8n/Cron/Backup). Bei Überschreitung antworten sie mit 429: für Browser-Seitenaufrufe (Accept text/html) mit der
// normalen Fehlerseite samt Wartezeit, für fetch- und Maschinenaufrufe mit JSON. Der Retry-After-Kopf bleibt in beiden Fällen.

import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import { erwartetHtml } from '../utils/rueckkehrZiel.js';

export const RATE_LIMIT_MESSAGE = { error: 'Zu viele Anfragen, bitte später erneut versuchen.' };

// Verständliche Wartezeit: «in etwa N Minuten» (mindestens 1). Quelle: Retry-After-Kopf (Sekunden), sonst resetTime der Bibliothek.
export function wartezeitText(req, res) {
  let sekunden = Number(res.getHeader('Retry-After'));
  if (!(sekunden > 0)) {
    const reset = req.rateLimit?.resetTime;
    sekunden = reset ? Math.ceil((new Date(reset).getTime() - Date.now()) / 1000) : 60;
  }
  const minuten = Math.max(1, Math.ceil(sekunden / 60));
  return `in etwa ${minuten} ${minuten === 1 ? 'Minute' : 'Minuten'}`;
}

/**
 * Baut den 429-Handler für express-rate-limit. Wiederverwendbar für weitere Limiter (z. B. je Person): `meldung` ersetzt
 * den Standardtext der Browser-Seite, die Wartezeit wird angehängt. JSON-Antwort und Retry-After-Kopf bleiben unverändert.
 * @param {{meldung?: string, json?: object}} [opts] meldung: Seitentext (Standard: «Zu viele Anfragen.»); json: JSON-Body (Standard: RATE_LIMIT_MESSAGE)
 * @returns {Function} Handler `(req, res) => void`
 */
export function createRateLimitHandler({ meldung = 'Zu viele Anfragen.', json = RATE_LIMIT_MESSAGE } = {}) {
  return (req, res) => {
    if (!erwartetHtml(req)) return res.status(429).json(json);
    const text = `${meldung} Bitte versuche es ${wartezeitText(req, res)} erneut.`;
    // Fehlt die Seitenvorlage (kleine Test-Apps) oder schlägt das Rendern fehl, bleibt es bei JSON.
    res.status(429).render('error', { titel: 'Gerade zu viele Anfragen', message: text, hinweisArt: 'warning' }, (err, html) => {
      if (err) return res.json(json);
      res.send(html);
    });
  };
}

const jsonRateLimitHandler = createRateLimitHandler();

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

// Gemeinsamer Schlüssel der Schreib-Limits: die angemeldete Person (nie die IP, sonst teilten sich Personen hinter
// einem Büro-Router ein Kontingent). Die Limiter sitzen in app.js hinter requireLogin; die IP ist nur Rückfall,
// falls ein Limiter einmal ohne Sitzung eingehängt wird. Fremde ohne Anmeldung erreichen sie nie und verbrauchen so kein Kontingent.
const personKey = (req) => (req.currentPerson ? `person:${req.currentPerson.churchtools_person_id}` : ipKeyGenerator(req.ip));

export const SPESEN_LIMIT_PRO_STUNDE = 10;
export const FEHLERMELDUNG_LIMIT_PRO_STUNDE = 5;

// Schreibende Routen mit Eigenlimit: Fehlschläge (Status >= 400, z. B. Formularfehler) zählen nicht mit,
// damit wer sich bei der Eingabe vertut, nicht ausgesperrt wird. Nur der Aufrufer entscheidet über die Methode (siehe nurPost).
function schreibLimiter({ limit, meldung, overrides }) {
  return rateLimit({
    windowMs: 60 * 60 * 1000,
    limit,
    keyGenerator: personKey,
    skipFailedRequests: true,
    ...COMMON_OPTIONS,
    handler: createRateLimitHandler({ meldung, json: { error: meldung } }),
    ...overrides,
  });
}

// Spesen einreichen: 10 Abrechnungen je Stunde und Person.
export function createSpesenRateLimiter(overrides = {}) {
  return schreibLimiter({
    limit: SPESEN_LIMIT_PRO_STUNDE,
    meldung: `Du hast in der letzten Stunde bereits ${SPESEN_LIMIT_PRO_STUNDE} Spesenabrechnungen eingereicht.`,
    overrides,
  });
}

// Fehler melden: 5 Meldungen je Stunde und Person.
export function createFehlerMeldenRateLimiter(overrides = {}) {
  return schreibLimiter({
    limit: FEHLERMELDUNG_LIMIT_PRO_STUNDE,
    meldung: `Du hast in der letzten Stunde bereits ${FEHLERMELDUNG_LIMIT_PRO_STUNDE} Fehlermeldungen gesendet.`,
    overrides,
  });
}

// Wendet den Limiter nur auf POST an (Seitenaufrufe per GET laufen nur durch den allgemeinen Limiter).
export function nurPost(limiter) {
  return (req, res, next) => (req.method === 'POST' ? limiter(req, res, next) : next());
}
