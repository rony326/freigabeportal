import express from 'express';
import session from 'express-session';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SqliteSessionStore } from './db/sessionStore.js';
import { createAuthRouter } from './routes/auth.js';
import { createCronRouter } from './routes/cron.js';
import { loadCurrentPerson } from './middleware/roles.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function createApp({ db, config }) {
  const app = express();
  app.locals.config = config;
  app.set('view engine', 'ejs');
  app.set('views', join(__dirname, '..', 'views'));
  app.use(express.json());
  app.use(
    session({
      store: new SqliteSessionStore(db),
      secret: config.sessionSecret,
      resave: false,
      saveUninitialized: false,
      cookie: { httpOnly: true, secure: config.env === 'production', maxAge: 24 * 60 * 60 * 1000 },
    })
  );
  app.use(loadCurrentPerson(db));

  app.use('/auth', createAuthRouter({ db, config }));
  app.use('/internal/cron', createCronRouter({ db, config }));

  app.get('/healthz', (req, res) => res.json({ status: 'ok' }));

  app.get('/', (req, res) => {
    res.render('home', { person: req.currentPerson ?? null });
  });

  app.use((req, res) => {
    res.status(404).render('error', { message: 'Seite nicht gefunden.' });
  });

  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).render('error', { message: 'Es ist ein unerwarteter Fehler aufgetreten. Bitte versuche es später erneut.' });
  });

  return app;
}
