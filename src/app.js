import express from 'express';
import session from 'express-session';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SqliteSessionStore } from './db/sessionStore.js';
import { createAuthRouter } from './routes/auth.js';
import { createCronRouter } from './routes/cron.js';
import { requireApiKey } from './middleware/apiKey.js';
import { createN8nJobsRouter } from './routes/n8n/jobs.js';
import { loadCurrentPerson, requireRole } from './middleware/roles.js';
import { loadBranding } from './middleware/branding.js';
import { createBrandingRouter } from './routes/branding.js';
import { createKontenRouter } from './routes/admin/konten.js';
import { createZuweisungsregelnRouter } from './routes/admin/zuweisungsregeln.js';
import { createEskalationRouter } from './routes/admin/eskalation.js';
import { createErscheinungsbildRouter } from './routes/admin/erscheinungsbild.js';
import { createPersonenRouter } from './routes/admin/personen.js';
import { createPdfEinstellungenRouter } from './routes/admin/pdf-einstellungen.js';
import { createPoolRouter } from './routes/pool.js';
import { createPoolPageRouter } from './routes/poolPage.js';
import { createDownloadsRouter } from './routes/downloads.js';
import { createKontierungRouter } from './routes/kontierung.js';
import { createFreigabe2Router } from './routes/freigabe2.js';
import { createAblehnungRouter } from './routes/ablehnung.js';
import { createMailer } from './services/mailer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function createApp({ db, config }) {
  const app = express();
  app.set('trust proxy', 1);
  app.set('view engine', 'ejs');
  app.set('views', join(__dirname, '..', 'views'));
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
        secure: config.env === 'production',
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

  app.use('/branding', createBrandingRouter({ db }));
  app.use('/admin', requireRole(config, 'portal-admin'));
  app.use('/admin/konten', createKontenRouter({ db }));
  app.use('/admin/zuweisungsregeln', createZuweisungsregelnRouter({ db }));
  app.use('/admin/eskalation', createEskalationRouter({ db }));
  app.use('/admin/erscheinungsbild', createErscheinungsbildRouter({ db, config }));
  app.use('/admin/personen', createPersonenRouter({ db }));
  app.use('/admin/pdf-einstellungen', createPdfEinstellungenRouter({ db }));

  app.use('/api/n8n/jobs', requireApiKey(config), createN8nJobsRouter({ db, config, mailer }));
  app.use('/api/pool', requireRole(config, 'buchhaltung'), createPoolRouter({ db }));
  app.use('/pool', requireRole(config, 'buchhaltung'), createPoolPageRouter({ db, config }));
  app.use('/downloads', createDownloadsRouter({ db, config }));
  app.use('/kontierung', requireRole(config, 'buchhaltung'), createKontierungRouter({ db, config }));
  app.use('/freigabe2', requireRole(config, 'buchhaltung'), createFreigabe2Router({ db, config }));
  app.use('/abgelehnt', requireRole(config, 'buchhaltung'), createAblehnungRouter({ db }));

  app.use('/auth', createAuthRouter({ db, config }));
  app.use('/internal/cron', createCronRouter({ db, config }));

  app.get('/healthz', (req, res) => res.json({ status: 'ok' }));

  app.get('/', (req, res) => {
    const isBuchhaltung = Boolean(
      req.currentPerson && req.currentPerson.gruppen.includes(String(config.churchtools.groupIdBuchhaltung))
    );
    res.render('home', { person: req.currentPerson ?? null, isBuchhaltung });
  });

  app.use((req, res) => {
    res.status(404).render('error', { message: 'Seite nicht gefunden.' });
  });

  app.use((err, req, res, next) => {
    console.error(err);
    res.locals.branding ??= { primaryColor: null, secondaryColor: null, hasLogo: false, themeAttr: null };
    res.status(500).render('error', { message: 'Es ist ein unerwarteter Fehler aufgetreten. Bitte versuche es später erneut.' });
  });

  return app;
}
