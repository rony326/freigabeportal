import { loadConfig } from './config/env.js';
import { openDatabase } from './db/index.js';
import { seedDefaults } from './db/adminConfigRepo.js';
import { createApp } from './app.js';
import { createMailerOrFallback } from './services/mailer.js';
import { startScheduler } from './services/scheduler.js';
import { acquireStorageLock, resolveStorageConfig } from './services/storageState.js';

const baseConfig = loadConfig();
const lock = acquireStorageLock(baseConfig);
let db;
process.once('exit', () => {
  // A failed database open may have left an unknown handle/transaction. Keep the lock then.
  if (!db) return;
  try { db.close(); lock.release(); }
  catch (err) { console.error('Datenspeicher konnte nicht sauber geschlossen werden; Sperre bleibt bestehen:', err.message); }
});

try {
  const config = resolveStorageConfig(baseConfig);
  db = openDatabase(config.dbPath);
  seedDefaults(db);
  const app = createApp({ db, config });
  startScheduler({ db, config, mailer: createMailerOrFallback(config.smtp) });
  const server = app.listen(config.port, () => {
    console.log(`Freigabeportal läuft auf Port ${config.port}`);
  });
  server.once('error', (err) => { console.error(err.message); process.exit(1); });
  function shutdown() {
    server.close(() => process.exit(0));
    server.closeIdleConnections();
    setTimeout(() => process.exit(1), 30000).unref();
  }
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
} catch (err) {
  console.error('Portal konnte nicht gestartet werden:', err.message);
  process.exitCode = 1;
}
