// Einstiegspunkt des Freigabeportals (`npm start`).
//
// Reihenfolge beim Start (Details: docs/architektur.md, Abschnitt "Bootstrap"):
//   1. Prozesswächter installieren, Umgebungsvariablen laden und validieren
//   2. Datenspeicher exklusiv sperren (nie zwei Prozesse auf derselben SQLite-Datei)
//   3. Datenbank öffnen (Schema + Migrationen), Standardwerte säen
//   4. Express-App bauen, Hintergrund-Jobs (Scheduler) starten, auf Port lauschen
// Beim Beenden (SIGTERM/SIGINT) wird sauber heruntergefahren; nach 30 s erzwingt ein Timer den Exit.

import { loadConfig } from './config/env.js';
import { openDatabase } from './db/index.js';
import { seedDefaults } from './db/adminConfigRepo.js';
import { createApp } from './app.js';
import { createMailerOrFallback } from './services/mailer.js';
import { startScheduler } from './services/scheduler.js';
import { acquireStorageLock, resolveStorageConfig } from './services/storageState.js';
import { installeProzessWaechter } from './services/prozessWaechter.js';
import { pruefeGespeicherteTsaUrl } from './services/tsaUrlPruefung.js';
import { konfigurierePdfArbeit, schliessePdfWorker } from './services/pdfArbeit.js';

// A4-02: Sicherheitsnetz für unbehandelte Ausnahmen/Promise-Ablehnungen — ganz früh registriert,
// damit es auch Fehler beim Start noch erfasst (loggt, dann sauberer Exit → Plattform-Neustart).
installeProzessWaechter();

const baseConfig = loadConfig();
// B2: PDF-Verarbeitung (Worker-Pool oder, mit PDF_WORKER=aus, Hauptthread); Worker starten erst beim ersten Auftrag.
konfigurierePdfArbeit(baseConfig.pdfWorker);
const lock = acquireStorageLock(baseConfig);
let db;
process.once('exit', () => {
  // Ein fehlgeschlagenes Öffnen der Datenbank kann ein unbekanntes Handle/eine offene Transaktion hinterlassen haben; dann bleibt die Sperre bestehen.
  if (!db) return;
  try { db.close(); lock.release(); }
  catch (err) { console.error('Datenspeicher konnte nicht sauber geschlossen werden; Sperre bleibt bestehen:', err.message); }
});

try {
  const config = resolveStorageConfig(baseConfig);
  db = openDatabase(config.dbPath);
  seedDefaults(db);
  // S6: gespeicherte TSA-Adresse prüfen (nur Warnung im Log; sie wird weiter benutzt, die Admin-Seite Zeitstempel warnt ebenfalls).
  pruefeGespeicherteTsaUrl(db).then((r) => {
    if (r && !r.ok) console.warn(`WARNUNG: Die gespeicherte TSA-Adresse erfüllt die Sicherheitsregeln nicht (${r.grund}). Sie wird weiter benutzt; bitte unter Admin → Zeitstempel durch eine https://-Adresse eines öffentlichen Dienstes ersetzen.`);
  }).catch((err) => console.error('TSA-Adresse konnte nicht geprüft werden:', err.message));
  const app = createApp({ db, config });
  startScheduler({ db, config, mailer: createMailerOrFallback(config.smtp) });
  const server = app.listen(config.port, () => {
    console.log(`Freigabeportal läuft auf Port ${config.port}`);
  });
  server.once('error', (err) => { console.error(err.message); process.exit(1); });
  function shutdown() {
    // Spiel-DB des Testmodus vor dem Beenden schliessen (die echte DB schliesst der exit-Handler).
    // Danach die PDF-Worker beenden (laufende Aufträge werden abgebrochen; offene Anfragen sind da bereits beantwortet).
    server.close(() => {
      Promise.resolve(app.get('testmodusSteuerung')?.schliessen())
        .catch((err) => console.error('Testmodus-Spielwiese konnte nicht geschlossen werden:', err.message))
        .then(() => schliessePdfWorker())
        .catch((err) => console.error('PDF-Worker konnten nicht sauber beendet werden:', err.message))
        .finally(() => process.exit(0));
    });
    server.closeIdleConnections();
    setTimeout(() => process.exit(1), 30000).unref();
  }
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
} catch (err) {
  console.error('Portal konnte nicht gestartet werden:', err.message);
  process.exitCode = 1;
}
