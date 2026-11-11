// A4-02: Prozess-Sicherheitsnetz (Verfügbarkeit). Wird in src/index.js ganz früh installiert.
export function installeProzessWaechter({ prozess = process, logger = console, exit } = {}) {
  const beenden = exit ?? ((code) => prozess.exit(code));
  let beendet = false;
  function behandle(label, fehler) {
    if (beendet) return;
    beendet = true;
    logger.error(`${label}:`, fehler?.stack || fehler?.message || String(fehler));
    beenden(1);
  }
  prozess.on('uncaughtException', (err) => behandle('Unbehandelte Ausnahme (uncaughtException)', err));
  prozess.on('unhandledRejection', (grund) => behandle('Unbehandelte Promise-Ablehnung (unhandledRejection)', grund));
}
