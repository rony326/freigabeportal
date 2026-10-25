import { erstelleSpielwiese } from './spielwiese.js';

// Hält die Test-Instanz (Spiel-DB + App) im Speicher: lazy beim ersten Bedarf erzeugt, beim
// Zurücksetzen neu gebaut (alte Spiel-DB geschlossen). Scheitert das Erzeugen, bleibt nichts
// zwischengespeichert, damit ein späterer Versuch neu beginnt.
// baueTestApp({ db, config }) kommt von app.js (vermeidet einen Import-Kreis).
export function createTestmodusSteuerung({ echteDb, config, baueTestApp }) {
  let aktuell = null; // Promise<{ app, db, config }>

  async function erzeuge(neu) {
    const sp = await erstelleSpielwiese(echteDb, config, { neu });
    try {
      return { app: baueTestApp(sp), db: sp.db, config: sp.config };
    } catch (err) {
      sp.db.close();
      throw err;
    }
  }

  async function schliesse(instanz) {
    try {
      const { db } = await instanz;
      if (db.isOpen) db.close();
    } catch { /* fehlgeschlagene oder bereits geschlossene Instanz */ }
  }

  function starte(vorher, neu) {
    const p = (async () => {
      if (vorher) await schliesse(vorher);
      return erzeuge(neu);
    })();
    aktuell = p;
    p.catch(() => { if (aktuell === p) aktuell = null; });
    return p;
  }

  return {
    hole: () => aktuell ?? starte(null, false),
    zuruecksetzen: () => starte(aktuell, true),
    async schliessen() {
      const vorher = aktuell;
      aktuell = null;
      if (vorher) await schliesse(vorher);
    },
  };
}
