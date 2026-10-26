// A4-02: Prozess-Sicherheitsnetz (Verfügbarkeit).
//
// Express 4 leitet abgelehnte Promises aus async-Route-Handlern NICHT an den zentralen
// Fehler-Handler weiter: ein einziger async-Handler, der ein ablehnendes await ohne internes
// try/catch aufruft, erzeugt eine unhandledRejection. Node 22 beendet den Prozess bei einer
// unbehandelten Ausnahme UND (per Default) bei einer unbehandelten Promise-Ablehnung ohnehin.
//
// Dieses Netz ändert daran nichts am "beenden", ergänzt aber zweierlei: (1) eine klare Logzeile
// mit Bezug — nur der Fehler selbst, nie Konfiguration oder Geheimnisse — damit der Ausfall im Log
// nachvollziehbar ist; (2) einen sauberen Exit, sodass der in index.js registrierte exit-Handler
// die Datenbank schliesst und die Speicher-Sperre freigibt und anschliessend der Infomaniak-
// Auto-Restart (Betriebs-Checkliste O2) übernimmt. Bewusst wird in BEIDEN Fällen beendet: nach
// einer unbehandelten Ausnahme/Ablehnung ist der Prozesszustand undefiniert; ein sauberer Neustart
// ist verlässlicher, als mit möglicherweise halbfertigem Zustand weiterzulaufen.
//
// Re-entrancy-geschützt: ein weiterer Fehler während des Beendens löst keine Endlosschleife und
// keinen zweiten Exit aus.
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
