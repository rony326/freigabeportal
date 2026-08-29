import { doubleCsrf } from 'csrf-csrf';

// Double-submit-cookie CSRF protection (csrf-csrf, not the deprecated csurf). Tokens are tied to
// the session id (getSessionIdentifier), so a token issued before login is naturally invalidated
// by auth.js's req.session.regenerate() on login — generateCsrfToken silently issues a fresh one
// next time it's called rather than throwing.
//
// getCsrfTokenFromRequest checks both the form body (_csrf hidden field, the vast majority of
// routes) and the x-csrf-token header (the two fetch()-based AJAX endpoints: POST
// /kontierung/lieferanten and POST /api/pool/:id/beanspruchen, neither of which submits a form
// body). Both sources are explicit and mutually exclusive per request shape, not a blind
// fallthrough over untrusted input.
export function createCsrfProtection(config) {
  const { doubleCsrfProtection, generateCsrfToken } = doubleCsrf({
    getSecret: () => config.sessionSecret,
    getSessionIdentifier: (req) => req.session.id,
    cookieName: 'csrf-token',
    cookieOptions: {
      sameSite: 'lax',
      path: '/',
      // Mirrors app.js's session cookie: secure is derived from publicBaseUrl rather than
      // NODE_ENV so local/test HTTP traffic still gets the cookie set.
      secure: Boolean(config.publicBaseUrl?.startsWith('https://')),
      httpOnly: true,
    },
    getCsrfTokenFromRequest: (req) => req.body?._csrf || req.headers['x-csrf-token'],
  });

  function attachCsrfToken(req, res, next) {
    res.locals.csrfToken = generateCsrfToken(req, res);
    next();
  }

  return { attachCsrfToken, csrfProtection: doubleCsrfProtection };
}
