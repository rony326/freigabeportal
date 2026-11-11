// CSRF-Schutz für alle Formulare und die beiden fetch()-Endpunkte – Hintergründe direkt unterhalb.
// Abdeckung aller schreibenden Routen erzwingt test/integration/csrfSweep.test.js.

import { doubleCsrf } from 'csrf-csrf';

// CSRF-Schutz per Double-Submit-Cookie (csrf-csrf, nicht das veraltete csurf). Die Tokens sind an die Session-ID
// gebunden (getSessionIdentifier): ein vor der Anmeldung ausgestelltes Token wird durch das req.session.regenerate()
// in auth.js bei der Anmeldung von selbst ungültig — generateCsrfToken stellt beim nächsten Aufruf still ein neues
// aus, statt zu werfen.
//
// getCsrfTokenFromRequest prüft sowohl den Formular-Body (Hidden-Feld _csrf, die grosse Mehrheit der Routen) als
// auch den Header x-csrf-token (die zwei fetch()-basierten AJAX-Endpunkte POST /kontierung/lieferanten und
// POST /api/pool/:id/beanspruchen, die keinen Formular-Body senden). Beide Quellen sind ausdrücklich und je nach
// Anfrageform getrennt, kein blindes Durchreichen unvertrauter Eingaben.
/**
 * @param {object} config Laufzeitkonfiguration (braucht `sessionSecret`, `publicBaseUrl`, optional `testmodus`)
 * @returns {{attachCsrfToken: Function, csrfProtection: Function, generateCsrfToken: Function}}
 *   `attachCsrfToken` legt `res.locals.csrfToken` für die Views an; `csrfProtection` ist die Prüf-Middleware
 *   für schreibende Routen; `generateCsrfToken` erzeugt ein Token ausserhalb der Views.
 */
export function createCsrfProtection(config) {
  const { doubleCsrfProtection, generateCsrfToken } = doubleCsrf({
    getSecret: () => config.sessionSecret,
    getSessionIdentifier: (req) => req.session.id,
    // Test-Instanz: eigenes Cookie (und abgeleitetes Geheimnis aus der Test-Konfiguration).
    cookieName: config.testmodus ? 'csrf-token-testmodus' : 'csrf-token',
    cookieOptions: {
      sameSite: 'lax',
      path: '/',
      // Wie beim Session-Cookie in app.js: `secure` wird aus publicBaseUrl abgeleitet statt aus NODE_ENV, damit
      // lokaler/Test-HTTP-Verkehr das Cookie trotzdem bekommt.
      secure: Boolean(config.publicBaseUrl?.startsWith('https://')),
      httpOnly: true,
    },
    getCsrfTokenFromRequest: (req) => req.body?._csrf || req.headers['x-csrf-token'],
  });

  // Stellt jeder Seite ein frisches Token als `res.locals.csrfToken` bereit (Hidden-Feld `_csrf` in den Formularen).
  function attachCsrfToken(req, res, next) {
    res.locals.csrfToken = generateCsrfToken(req, res);
    next();
  }

  return { attachCsrfToken, csrfProtection: doubleCsrfProtection, generateCsrfToken };
}
