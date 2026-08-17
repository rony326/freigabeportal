import express from 'express';
import session from 'express-session';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SqliteSessionStore } from './db/sessionStore.js';
import { createAuthRouter } from './routes/auth.js';
import { createCronRouter } from './routes/cron.js';
import { requireApiKey } from './middleware/apiKey.js';
import { requireCronSecret } from './middleware/cronAuth.js';
import { createN8nJobsRouter } from './routes/n8n/jobs.js';
import { loadCurrentPerson, requireRole, requireAnyRole, requireLogin } from './middleware/roles.js';
import { loadBranding } from './middleware/branding.js';
import { createBrandingRouter } from './routes/branding.js';
import { createKontenRouter } from './routes/admin/konten.js';
import { createZuweisungsregelnRouter } from './routes/admin/zuweisungsregeln.js';
import { createEskalationRouter } from './routes/admin/eskalation.js';
import { createErscheinungsbildRouter } from './routes/admin/erscheinungsbild.js';
import { createPersonenRouter } from './routes/admin/personen.js';
import { createPdfEinstellungenRouter } from './routes/admin/pdf-einstellungen.js';
import { createMailsRouter } from './routes/admin/mails.js';
import { createSyncRouter } from './routes/admin/sync.js';
import { createPoolRouter } from './routes/pool.js';
import { createPoolPageRouter } from './routes/poolPage.js';
import { createDownloadsRouter } from './routes/downloads.js';
import { createKontierungRouter } from './routes/kontierung.js';
import { createFreigabe2Router } from './routes/freigabe2.js';
import { createAblehnungRouter } from './routes/ablehnung.js';
import { createMailer } from './services/mailer.js';
import { createPublicRateLimiter, createSessionRateLimiter, createMachineRateLimiter } from './middleware/rateLimit.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function createApp({ db, config }) {
  const app = express();
  app.set('trust proxy', 1);
  app.set('view engine', 'ejs');
  app.set('views', join(__dirname, '..', 'views'));
  app.use(express.static(join(__dirname, '..', 'public')));
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
    next();
  });
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
  app.use(loadCurrentPerson(db));

  let mailer;
  try {
    mailer = createMailer(config.smtp);
  } catch (err) {
    console.error('Mailer konnte nicht initialisiert werden, E-Mail-Versand ist deaktiviert:', err.message);
    mailer = {
      async sendMail() {
        throw new Error('SMTP ist nicht konfiguriert.');
      },
    };
  }

  const publicLimiter = createPublicRateLimiter();
  const sessionLimiter = createSessionRateLimiter();
  const machineLimiter = createMachineRateLimiter();

  app.use('/branding', publicLimiter, createBrandingRouter({ db }));
  app.use('/admin', sessionLimiter, requireRole(config, 'portal-admin'));
  app.use('/admin/konten', createKontenRouter({ db }));
  app.use('/admin/zuweisungsregeln', createZuweisungsregelnRouter({ db }));
  app.use('/admin/eskalation', createEskalationRouter({ db }));
  app.use('/admin/erscheinungsbild', createErscheinungsbildRouter({ db, config }));
  app.use('/admin/personen', createPersonenRouter({ db }));
  app.use('/admin/pdf-einstellungen', createPdfEinstellungenRouter({ db }));
  app.use('/admin/mails', createMailsRouter({ db, mailer }));
  app.use('/admin/sync', createSyncRouter({ db }));

  app.use('/api/n8n/jobs', machineLimiter, requireApiKey(config), createN8nJobsRouter({ db, config, mailer }));
  app.use('/api/pool', sessionLimiter, requireRole(config, 'buchhaltung'), createPoolRouter({ db }));
  app.use('/pool', sessionLimiter, requireAnyRole(config, ['buchhaltung', 'portal-admin']), createPoolPageRouter({ db, config }));
  app.use('/downloads', publicLimiter, createDownloadsRouter({ db, config }));
  app.use('/kontierung', sessionLimiter, requireLogin(), createKontierungRouter({ db, config, mailer }));
  app.use('/freigabe2', sessionLimiter, requireLogin(), createFreigabe2Router({ db, config, mailer }));
  app.use('/abgelehnt', sessionLimiter, requireLogin(), createAblehnungRouter({ db, config }));

  app.use('/auth', publicLimiter, createAuthRouter({ db, config }));
  app.use('/internal/cron', machineLimiter, requireCronSecret(config), createCronRouter({ db, config, mailer }));

  app.get('/healthz', (req, res) => res.json({ status: 'ok' }));

  app.get('/', publicLimiter, (req, res) => {
    const isBuchhaltung = Boolean(
      req.currentPerson && req.currentPerson.gruppen.includes(String(config.churchtools.groupIdBuchhaltung))
    );
    res.render('home', { person: req.currentPerson ?? null, isBuchhaltung });
  });

  app.use((req, res) => {
    res.status(404).render('error', { message: 'Seite nicht gefunden.' });
  });

  app.use((err, req, res, next) => {
    console.error(err.stack || err);
    res.locals.branding ??= { primaryColor: null, secondaryColor: null, hasLogo: false, themeAttr: null };
    res.status(500).render('error', { message: 'Es ist ein unerwarteter Fehler aufgetreten. Bitte versuche es später erneut.' });
  });

  return app;
}
