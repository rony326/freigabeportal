import { loadConfig } from './config/env.js';
import { openDatabase } from './db/index.js';
import { seedDefaults } from './db/adminConfigRepo.js';
import { createApp } from './app.js';
import { createMailerOrFallback } from './services/mailer.js';
import { startScheduler } from './services/scheduler.js';

const config = loadConfig();
const db = openDatabase(config.dbPath);
seedDefaults(db);
const app = createApp({ db, config });

// Runs the three /internal/cron/* jobs (sync-personen nightly, pool-erinnerungen hourly,
// pdf-bereinigung nightly) on its own timers, independent of any external scheduler — see
// services/scheduler.js. A second mailer instance here (rather than reusing app.js's) keeps
// createApp()'s return shape unchanged for the many tests that call it directly.
startScheduler({ db, config, mailer: createMailerOrFallback(config.smtp) });

app.listen(config.port, () => {
  console.log(`Freigabeportal läuft auf Port ${config.port}`);
});
