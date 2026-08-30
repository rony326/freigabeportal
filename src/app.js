import express from 'express';
import session from 'express-session';
import cookieParser from 'cookie-parser';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SqliteSessionStore } from './db/sessionStore.js';
import { createAuthRouter } from './routes/auth.js';
import { createCronRouter } from './routes/cron.js';
import { requireApiKey } from './middleware/apiKey.js';
import { requireCronSecret } from './middleware/cronAuth.js';
import { createCsrfProtection } from './middleware/csrf.js';
import { createN8nJobsRouter } from './routes/n8n/jobs.js';
import { createN8nBackupRouter } from './routes/n8n/backup.js';
import { loadCurrentPerson, requireRole, requireAnyRole, requireLogin } from './middleware/roles.js';
import { requireAdminAreaAccess, requirePermission } from './middleware/permissions.js';
import { loadNavFlags } from './middleware/nav.js';
import { loadBranding } from './middleware/branding.js';
import { createBrandingRouter } from './routes/branding.js';
import { createKontenRouter } from './routes/admin/konten.js';
import { createDebitorenRouter } from './routes/admin/debitoren.js';
import { createEskalationRouter } from './routes/admin/eskalation.js';
import { createErscheinungsbildRouter } from './routes/admin/erscheinungsbild.js';
import { countZeitstempelUeberfaellig } from './db/jobsRepo.js';
import { getConfigValue } from './db/adminConfigRepo.js';
import { createZeitstempelAdminRouter } from './routes/admin/zeitstempel.js';
import { createPersonenRouter } from './routes/admin/personen.js';
import { createMailsRouter } from './routes/admin/mails.js';
import { createSyncRouter } from './routes/admin/sync.js';
import { createAdminAbgelehntRouter } from './routes/admin/abgelehnt.js';
import { createGeplanteJobsRouter } from './routes/admin/geplanteJobs.js';
import { createBackupRouter } from './routes/admin/backup.js';
import { createPoolRouter } from './routes/pool.js';
import { createPoolPageRouter } from './routes/poolPage.js';
import { createDownloadsRouter } from './routes/downloads.js';
import { createKontierungRouter } from './routes/kontierung.js';
import { createFreigabe2Router } from './routes/freigabe2.js';
import { createAblehnungRouter } from './routes/ablehnung.js';
import { createZeitstempelPruefenRouter } from './routes/zeitstempelPruefen.js';
import { createMailerOrFallback } from './services/mailer.js';
import { createPublicRateLimiter, createSessionRateLimiter, createMachineRateLimiter } from './middleware/rateLimit.js';
import { getVersionInfo } from './utils/version.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function createApp({ db, config }) {
  const app = express();
  app.set('trust proxy', 1);
  app.set('view engine', 'ejs');
  app.set('views', join(__dirname, '..', 'views'));
  // Computed once at startup, not per request — the deployed commit doesn't change while the
  // process is running, and shelling out to git on every request would be wasteful.
  app.locals.version = getVersionInfo(join(__dirname, '..'));
  app.use((req, res, next) => {
    // X-Content-Type-Options: the PDF magic-byte check on upload only validates the first 4
    // bytes, so this stops a browser from sniffing a crafted upload into something other than
    // its declared Content-Type when served back from /downloads or /branding.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // X-Frame-Options: SAMEORIGIN, not DENY — kontierung.ejs, freigabe2.ejs, and pool.ejs all
    // embed the signed-download-URL PDF preview in a same-origin <iframe>, and DENY blocks
    // framing even from the same origin. SameSite=Lax cookies already aren't sent on cross-site
    // framed subresource requests, so SAMEORIGIN still closes the cross-site framing case.
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    // Referrer-Policy: signed download URLs carry their signature in the query string
    // (services/downloadUrl.js) and are embedded in <iframe> previews — without this, a link
    // clicked inside a rendered invoice PDF could leak a live, still-valid download URL to a
    // third party via the Referer header.
    res.setHeader('Referrer-Policy', 'no-referrer');
    // Content-Security-Policy: defense-in-depth backstop, not the primary XSS defense — every EJS
    // view was audited to only ever use auto-escaping `<%= %>` on user-controlled data (`<%- %>`
    // is used exclusively for trusted static `include()`s), so there's no known unescaped-output
    // path today. 'unsafe-inline' is required for script-src/style-src because several views use
    // inline <script> blocks and style="" attributes without nonces; a future refactor to
    // nonce-based CSP could drop it. Still meaningfully restricts where a future injection could
    // load resources from or exfiltrate to, and blocks base-tag/form-action hijacking outright.
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
        "img-src 'self'; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; " +
        "form-action 'self'; frame-ancestors 'self'"
    );
    next();
  });
  app.use(express.static(join(__dirname, '..', 'public')));
  app.use(loadBranding(db));
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use(
    session({
      store: new SqliteSessionStore(db),
      secret: config.sessionSecret,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        // Derived from publicBaseUrl (always required in production via env.js) rather than
        // NODE_ENV, which nothing enforces being set correctly on the host — an unset NODE_ENV
        // would otherwise silently boot the app without the Secure flag on a TLS-required deployment.
        secure: Boolean(config.publicBaseUrl?.startsWith('https://')),
        sameSite: 'lax',
        maxAge: 24 * 60 * 60 * 1000,
      },
    })
  );
  // cookie-parser must run after express-session (session parses its own cookie first) and
  // before the CSRF middleware, which reads/writes its own separate, non-session cookie.
  app.use(cookieParser());
  const { attachCsrfToken, csrfProtection } = createCsrfProtection(config);
  app.use((req, res, next) => {
    // /api/n8n/* and /internal/cron/* are machine routes authenticated via X-API-Key /
    // X-Cron-Secret headers, never session cookies — they send no CSRF cookie or token and must
    // stay exempt. /api/pool is session-cookie authenticated (its beanspruchen button is a
    // fetch() call, protected via the x-csrf-token header instead of a form field) and does need
    // this.
    if (req.path.startsWith('/api/n8n/') || req.path.startsWith('/internal/cron')) return next();
    return attachCsrfToken(req, res, next);
  });
  app.use(loadCurrentPerson(db));
  app.use(loadNavFlags(db, config));

  const mailer = createMailerOrFallback(config.smtp);

  const publicLimiter = createPublicRateLimiter();
  const sessionLimiter = createSessionRateLimiter();
  const machineLimiter = createMachineRateLimiter();

  app.use('/branding', publicLimiter, createBrandingRouter({ db }));
  app.use('/admin', sessionLimiter, requireAdminAreaAccess(db, config));
  app.get('/admin', (req, res) => {
    const zeitstempelWarnungSchwelle = Number(getConfigValue(db, 'zeitstempel_warnung_ab_stunden'));
    const tsaAktiv = Boolean(getConfigValue(db, 'zeitstempel_tsa_url'));
    res.render('admin/dashboard', {
      zeitstempelUeberfaellig: tsaAktiv ? countZeitstempelUeberfaellig(db, zeitstempelWarnungSchwelle) : 0,
      zeitstempelWarnungSchwelle,
    });
  });
  app.use('/admin/konten', requirePermission(db, config, 'konten_verwalten'), createKontenRouter({ db, csrfProtection }));
  app.use('/admin/debitoren', requirePermission(db, config, 'debitoren_verwalten'), createDebitorenRouter({ db, csrfProtection }));
  app.use('/admin/eskalation', requireRole(config, 'superadmin'), createEskalationRouter({ db, csrfProtection }));
  app.use('/admin/erscheinungsbild', requireRole(config, 'superadmin'), createErscheinungsbildRouter({ db, config, csrfProtection }));
  app.use('/admin/zeitstempel', requireRole(config, 'superadmin'), createZeitstempelAdminRouter({ db, csrfProtection }));
  app.use('/admin/personen', requireAnyRole(config, ['superadmin', 'manager']), createPersonenRouter({ db, config, csrfProtection }));
  app.use('/admin/mails', requirePermission(db, config, 'mails_einsehen'), createMailsRouter({ db, mailer, csrfProtection }));
  app.use('/admin/sync', requirePermission(db, config, 'sync_einsehen'), createSyncRouter({ db, csrfProtection }));
  app.use('/admin/abgelehnt', requirePermission(db, config, 'abgelehnt_verwalten'), createAdminAbgelehntRouter({ db, config, csrfProtection }));
  app.use('/admin/geplante-jobs', requirePermission(db, config, 'geplante_jobs_verwalten'), createGeplanteJobsRouter({ db, config, mailer, csrfProtection }));
  app.use('/admin/backup', requireRole(config, 'superadmin'), createBackupRouter({ db, config, csrfProtection }));

  app.use('/api/n8n/jobs', machineLimiter, requireApiKey(config), createN8nJobsRouter({ db, config, mailer }));
  app.use('/api/n8n/backup', machineLimiter, requireApiKey(config), createN8nBackupRouter({ config }));
  app.use('/api/pool', sessionLimiter, requireRole(config, 'buchhaltung'), createPoolRouter({ db, csrfProtection }));
  // Dashboard for every logged-in person, not just Buchhaltung/Superadmin: "/" always redirects
  // here now that the old landing page is gone, and a Freigeber1/2-only person (no group
  // membership, AUTH-WIDEN-1) needs somewhere to land too. The pool-of-unassigned-invoices
  // section itself stays restricted inside pool.ejs (gated on isBuchhaltung/isSuperadmin from
  // loadNavFlags) — only the route-level gate widens, not who can see the company-wide pool.
  app.use('/pool', sessionLimiter, requireLogin(), createPoolPageRouter({ db, config }));
  app.use('/downloads', createDownloadsRouter({ db, config, sessionLimiter, publicLimiter }));
  app.use('/kontierung', sessionLimiter, requireLogin(), createKontierungRouter({ db, config, mailer, csrfProtection }));
  app.use('/freigabe2', sessionLimiter, requireLogin(), createFreigabe2Router({ db, config, mailer, csrfProtection }));
  app.use('/abgelehnt', sessionLimiter, requireLogin(), createAblehnungRouter({ db, config, csrfProtection }));
  app.use('/zeitstempel-pruefen', sessionLimiter, requireLogin(), createZeitstempelPruefenRouter({ db, config, csrfProtection }));

  app.use('/auth', publicLimiter, createAuthRouter({ db, config, csrfProtection }));
  app.use('/internal/cron', machineLimiter, requireCronSecret(config), createCronRouter({ db, config, mailer }));

  app.get('/healthz', (req, res) => res.json({ status: 'ok' }));

  // No standalone landing page: every visit to "/" goes straight to the dashboard (/pool) for a
  // logged-in person, or to login for an anonymous one.
  app.get('/', publicLimiter, (req, res) => {
    res.redirect(req.currentPerson ? '/pool' : '/auth/login');
  });

  app.use((req, res) => {
    res.status(404).render('error', { message: 'Seite nicht gefunden.' });
  });

  app.use((err, req, res, next) => {
    res.locals.branding ??= { primaryColor: null, secondaryColor: null, hasLogo: false, themeAttr: null, seitenTitel: 'Freigabeportal' };
    if (err.code === 'EBADCSRFTOKEN') {
      // Most likely a stale/expired form (session changed since it was loaded, e.g. logged out
      // and back in another tab) rather than an actual attack — no need to log.stack this one.
      return res
        .status(403)
        .render('error', { message: 'Sicherheitsprüfung fehlgeschlagen (ungültiges oder abgelaufenes Formular). Bitte lade die Seite neu und versuche es erneut.' });
    }
    console.error(err.stack || err);
    res.status(500).render('error', { message: 'Es ist ein unerwarteter Fehler aufgetreten. Bitte versuche es später erneut.' });
  });

  return app;
}
