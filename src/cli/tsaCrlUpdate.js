import { parseArgs } from 'node:util';
import { loadStorageConfig } from '../config/env.js';
import { resolveStorageConfig } from '../services/storageState.js';
import { openDatabase } from '../db/index.js';
import { getConfigValue } from '../db/adminConfigRepo.js';
import { aktualisiereTsaCrls } from '../services/tsaCrlUpdate.js';

// Betreiberwerkzeug: erneuert TSA_CRL_FILE einmalig (Ersteinrichtung, Test, Notfall) mit derselben
// Logik wie der geplante Job, unabhaengig von TSA_CRL_AUTO_UPDATE. Die TSA-URL kommt aus der
// Admin-Konfiguration oder aus --url (z.B. bevor sie im Portal eingetragen wird).
try {
  const { values } = parseArgs({ options: { url: { type: 'string' } } });
  let url = values.url;
  let user;
  let passwort;
  if (!url) {
    const db = openDatabase(resolveStorageConfig(loadStorageConfig()).dbPath);
    try {
      url = getConfigValue(db, 'zeitstempel_tsa_url');
      user = getConfigValue(db, 'zeitstempel_tsa_user') || undefined;
      passwort = getConfigValue(db, 'zeitstempel_tsa_passwort') || undefined;
    } finally { db.close(); }
  }
  if (!url) throw new Error('Keine TSA-URL konfiguriert; mit --url angeben.');
  const result = await aktualisiereTsaCrls({
    url, user, passwort,
    trustAnchorsFile: process.env.TSA_TRUST_ANCHORS_FILE,
    trustAnchorsSha256: process.env.TSA_TRUST_ANCHORS_SHA256,
    crlFile: process.env.TSA_CRL_FILE,
  });
  console.log(JSON.stringify({ datei: process.env.TSA_CRL_FILE, ...result }, null, 2));
} catch (err) {
  console.error(`TSA-Sperrlisten-Erneuerung fehlgeschlagen: ${err.message}`);
  process.exitCode = 1;
}
