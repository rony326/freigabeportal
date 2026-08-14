import { loadConfig } from './config/env.js';
import { openDatabase } from './db/index.js';
import { seedDefaults } from './db/adminConfigRepo.js';
import { createApp } from './app.js';

const config = loadConfig();
const db = openDatabase(config.dbPath);
seedDefaults(db);
const app = createApp({ db, config });

app.listen(config.port, () => {
  console.log(`Freigabeportal läuft auf Port ${config.port}`);
});
